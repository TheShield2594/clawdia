'use strict';

/**
 * A durable record of a payout that was claimed but never delivered (#804).
 *
 * Two scheduled jobs claim a record before paying out — `announceHourlyWinners`
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
 * Pays one owed payout, from the payload `recordOwedPayout` stored.
 *
 * Written to be handed straight to `retryJob`, which treats a return as paid and
 * a throw as still owed — so everything that means "not paid" has to throw,
 * including the quiet one: `findOneAndUpdate` without `upsert` resolves to
 * `null` when no document matches, which is exactly the case that made the
 * hourly credit lose a winner in silence to begin with.
 *
 * Two kinds, one per claim site:
 *
 *   coins  { kind: 'coins', userId, guildId, amount }
 *   items  { kind: 'items', userId, guildId, itemId, quantity }
 */
async function replayOwedPayout(payload) {
    const kind = payload?.kind;

    if (kind === 'coins') {
        const { userId, guildId, amount } = payload;
        if (!userId || !guildId || !(amount > 0)) {
            throw new Error(`owed coins payload is incomplete: ${JSON.stringify(payload)}`);
        }

        const User = require('../models/User');
        const credited = await User.findOneAndUpdate(
            { userId, guildId },
            { $inc: { balance: amount } },
        );
        if (!credited) {
            throw new Error(`no user document for ${userId} in ${guildId} — nothing to credit`);
        }
        return;
    }

    if (kind === 'items') {
        const { userId, guildId, itemId, quantity } = payload;
        if (!userId || !guildId || !itemId || !(quantity > 0)) {
            throw new Error(`owed items payload is incomplete: ${JSON.stringify(payload)}`);
        }

        const { grantInventoryItem } = require('./inventoryGrant');
        await grantInventoryItem(userId, guildId, itemId, quantity, { upsert: true });
        return;
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

module.exports = { recordOwedPayout, replayOwedPayout, describeOwedPayout, isOwedPayout, OWED_SUFFIX };
