'use strict';

/**
 * A durable record of a payout that was claimed but never delivered (#804).
 *
 * Two scheduled jobs claim a record before paying out — `announceWeeklyChampions`
 * flips a winner to `rewarded: true`, `returnExpiredMarketListings` deletes the
 * listing — and the claim is what makes them safe to run twice. It is also
 * one-way: once it is spent, the job's next tick finds nothing, so a credit that
 * fails after the claim is not merely unreported, it is unrepeatable. Throwing
 * gets the sweep onto /health and into the dead-letter queue, but the entry it
 * files names a *run*, and re-running the run pays nobody.
 *
 * So the thing owed is written down separately, per entry, with everything the
 * credit needs to be attempted again: who, where, and how much of what. That is
 * the shape `retryJob` in src/utils/jobRunner.js already replays — it calls
 * `handler(record.payload)` and marks the record resolved when the handler
 * returns — so the record is a `FailedJob` and the handler is `replayOwedPayout`
 * below. `scripts/replay-owed-payouts.js` is the operator-facing end of it.
 *
 * The precedent is src/utils/balanceDelta.js, which does the same thing for a
 * credit that fails in the middle of a command: retry, and if it still will not
 * land, record it as owed rather than lose it.
 */

const FailedJob = require('../models/FailedJob');
const { creditCoinsOnce, grantItemOnce, weeklyChampionPayoutKey, hourlyPayoutKey, listingPayoutKey } = require('./payoutKey');

// `jobName` on these records is the job that owed the payout, suffixed. runJob
// files its own entry under the bare job name when the sweep throws, and the two
// are different things: that one says "this run failed", this one says "this
// player is owed 500 coins". The suffix is what lets the replay script pick out
// the ones it knows how to pay without touching the rest of the queue.
const OWED_SUFFIX = '.owed';

/** True for a FailedJob written by `recordOwedPayout`. */
function isOwedPayout(record) {
    return typeof record?.jobName === 'string' && record.jobName.endsWith(OWED_SUFFIX);
}

/**
 * Writes down one undelivered payout.
 *
 * Never throws. The reason a payout failed is usually that the database is
 * unreachable, which is also the reason writing this down can fail — and a
 * caller that has already lost the credit must not then lose the rest of its
 * sweep to the bookkeeping. The caller still counts the failure and still fails
 * its job, so a queue write that does not land is at worst a failure recorded
 * one level coarser rather than a silent one.
 *
 * @param {object}  entry
 * @param {string}  entry.service  service the job belongs to, e.g. 'schedulerService'
 * @param {string}  entry.jobName  bare job name; the suffix is added here
 * @param {?string} entry.guildId  guild the payout belongs to
 * @param {object}  entry.payload  a `replayOwedPayout` payload — see below
 * @param {?Error}  entry.error    what went wrong, for the queue entry
 * @returns {Promise<boolean>} whether the record was written
 */
async function recordOwedPayout({ service, jobName, guildId = null, payload, error }) {
    try {
        await FailedJob.create({
            service,
            jobName: `${jobName}${OWED_SUFFIX}`,
            guildId,
            payload,
            errorMessage: error?.message ?? 'unknown error',
            errorStack: error?.stack ?? null,
            lastAttemptAt: new Date(),
        });
        return true;
    } catch (err) {
        console.error(
            `[${service}] ${jobName} could not record an owed payout ` +
            `(${JSON.stringify(payload)}):`, err.message,
        );
        return false;
    }
}

/**
 * The payout key for a stored payload (#807).
 *
 * `payoutKey` is written into the payload by everything that records one now, so
 * the replay applies the same key the original credit tried to. The derivations
 * below are for records written before the key existed: their payloads already
 * carry `week`/`hour` plus `category`, or `listingId`, which is exactly what the
 * key is made of, so those replay guarded too.
 *
 * `null` for anything with neither — a payload from a caller that never supplied
 * a key. That replay stays at-least-once, which is what it was before, and
 * `replayOwedPayout` says so in the log rather than pretending otherwise.
 */
function payoutKeyForPayload(payload) {
    if (typeof payload?.payoutKey === 'string' && payload.payoutKey) return payload.payoutKey;
    if (payload?.kind === 'coins' && payload.week && payload.category) {
        return weeklyChampionPayoutKey(payload.week, payload.category);
    }
    // The hourly competition is gone, but a payout it owed can still be sitting
    // in the queue, and it has to replay under the key it was written with.
    if (payload?.kind === 'coins' && payload.hour && payload.category) {
        return hourlyPayoutKey(payload.hour, payload.category);
    }
    if (payload?.kind === 'items' && payload.listingId) {
        return listingPayoutKey(payload.listingId);
    }
    return null;
}

/**
 * Pays one owed payout, from the payload `recordOwedPayout` stored.
 *
 * Written to be handed straight to `retryJob`, which treats a return as paid and
 * a throw as still owed — so everything that means "not paid" has to throw,
 * including the quiet one: `findOneAndUpdate` without `upsert` resolves to
 * `null` when no document matches, which is exactly the case that made the
 * hourly credit lose a winner in silence to begin with.
 *
 * With a payout key in the filter (#807) that `null` gained a second meaning —
 * "already applied" — and the two need opposite handling: 'missing' is still
 * owed and must throw, 'duplicate' is done and must return, or the replay loops
 * on a payout that has been paid. `classifyUnmatchedPayout` is what tells them
 * apart; the silent-skip #804 closed does not come back under a new name.
 *
 * Two kinds, one per claim site:
 *
 *   coins  { kind: 'coins', userId, guildId, amount,           payoutKey? }
 *   items  { kind: 'items', userId, guildId, itemId, quantity, payoutKey? }
 */
async function replayOwedPayout(payload) {
    const kind = payload?.kind;
    const key  = payoutKeyForPayload(payload);

    if (!key) {
        console.warn(
            `[owedPayout] replaying ${describeOwedPayout(payload)} without a payout key — ` +
            'this credit is at-least-once and a second replay would pay it again',
        );
    }

    if (kind === 'coins') {
        const { userId, guildId, amount } = payload;
        if (!userId || !guildId || !(amount > 0)) {
            throw new Error(`owed coins payload is incomplete: ${JSON.stringify(payload)}`);
        }

        const User = require('../models/User');
        if (!key) {
            const credited = await User.findOneAndUpdate(
                { userId, guildId },
                { $inc: { balance: amount } },
            );
            if (!credited) {
                throw new Error(`no user document for ${userId} in ${guildId} — nothing to credit`);
            }
            return;
        }

        const { status } = await creditCoinsOnce({ userId, guildId }, amount, key);
        if (status === 'paid') return;
        if (status === 'duplicate') {
            console.log(`[owedPayout] ${key} had already been applied — no coins moved`);
            return;
        }
        if (status === 'missing') {
            throw new Error(`no user document for ${userId} in ${guildId} — nothing to credit`);
        }
        throw new Error(`credit for ${userId} in ${guildId} matched nothing but ${key} is absent — retry`);
    }

    if (kind === 'items') {
        const { userId, guildId, itemId, quantity } = payload;
        if (!userId || !guildId || !itemId || !(quantity > 0)) {
            throw new Error(`owed items payload is incomplete: ${JSON.stringify(payload)}`);
        }

        if (!key) {
            const { grantInventoryItem } = require('./inventoryGrant');
            await grantInventoryItem(userId, guildId, itemId, quantity, { upsert: true });
            return;
        }

        const { status } = await grantItemOnce(
            { userId, guildId }, itemId, quantity, key, { upsert: true },
        );
        if (status === 'paid') return;
        if (status === 'duplicate') {
            console.log(`[owedPayout] ${key} had already been applied — no items granted`);
            return;
        }
        throw new Error(`return for ${userId} in ${guildId} matched nothing (${status}) — retry`);
    }

    throw new Error(`unknown owed payout kind: ${JSON.stringify(kind)}`);
}

/** Human-readable one-liner for a payload, for logs and the replay script. */
function describeOwedPayout(payload) {
    if (payload?.kind === 'coins') {
        return `${payload.amount} coins to ${payload.userId} in ${payload.guildId}`;
    }
    if (payload?.kind === 'items') {
        return `${payload.quantity}x ${payload.itemId} to ${payload.userId} in ${payload.guildId}`;
    }
    return JSON.stringify(payload);
}

module.exports = { recordOwedPayout, replayOwedPayout, describeOwedPayout, payoutKeyForPayload, isOwedPayout, OWED_SUFFIX };
