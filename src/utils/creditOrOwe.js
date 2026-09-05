'use strict';

/**
 * Pay a player, or write down that they were not paid.
 *
 * Three group payouts wrote their own version of this and each got a different
 * part of it wrong (#873).
 *
 * `/duel` refunded an escrowed stake with a bare `updateOne` and read the
 * absence of a throw as success — but an update whose filter matches nothing
 * resolves just as happily as one that moved coins, so a duel whose challenger
 * document had gone away told both players "both bets have been refunded" over a
 * stake that was still missing. `/syndicate` retried its share three times and
 * then set `credited = true` on whatever `findOneAndUpdate` returned, `null`
 * included, so the same unmatched write counted as paid and never reached the
 * recovery record sitting directly below it. `/heist` logged a rejected share
 * and moved on, leaving no record of it anywhere but the console.
 *
 * All three want what src/utils/coinTransfer.js already does for a two-party
 * transfer: attempt the credit, decide whether it landed by looking at what came
 * back, and — when it did not — file the debt where `npm run payouts:replay` can
 * settle it rather than letting it end at a log line.
 *
 * The credit is keyed, and the retry is why. A `$inc` is not idempotent, so
 * retrying one whose outcome is unknown (a write that committed and lost its
 * response) is how a credit lands twice; `/syndicate`'s three attempts were
 * exactly that. Putting the key in the write's own filter — src/utils/payoutKey.js
 * — makes the second attempt a no-op instead, so the retry is safe and the owed
 * record it eventually writes replays under the same key. That is the shape
 * `commitBalanceDelta` in src/utils/balanceDelta.js already uses, for the same
 * reason.
 */

const DEFAULT_USER = require('../models/User');
const { creditCoinsOnce, grantItemOnce } = require('./payoutKey');
const { counterSetExpr } = require('./balanceDebit');
const { windowedRefundExpr } = require('./giftCaps');
const { recordOwedPayout } = require('./owedPayout');
const { delay } = require('./delay');

const DEFAULT_ATTEMPTS = 3;

/**
 * Credits `amount` coins exactly once, and records the payout as owed when it
 * will not land.
 *
 * @param {object}   filter          the user's `{ userId, guildId }`
 * @param {number}   amount          coins to credit; a non-positive amount is a no-op
 * @param {object}   opts
 * @param {string}   opts.payoutKey  names *this* payout, so neither the retry
 *                                   below nor a replayed record can pay it twice
 * @param {string}   opts.service    for the owed record and the log line
 * @param {string}   opts.jobName
 * @param {object}   [opts.counters] further counters to move in the same write,
 *                                   as `{ path: delta }`, so bookkeeping that
 *                                   belongs with the credit cannot land without
 *                                   it. Stated as plain numbers rather than
 *                                   pipeline expressions because the owed record
 *                                   has to carry them: a `$`-keyed expression is
 *                                   not a thing to store in a document, and the
 *                                   replay has to rebuild the same write anyway
 * @param {number}   [opts.attempts]
 * @param {object}   [opts.Model]
 * @returns {Promise<{credited: boolean, owed: boolean, doc: ?object, error: ?Error}>}
 *
 * `credited: false` with `owed: true` means the coins are neither paid nor lost
 * but written down for an operator to settle — the caller has to say so rather
 * than announcing a payout that did not happen.
 */
async function creditCoinsOrOwe(filter, amount, {
    payoutKey, service = 'economy', jobName = 'credit', counters = {},
    attempts = DEFAULT_ATTEMPTS, Model = DEFAULT_USER,
} = {}) {
    const wanted = Math.floor(amount) || 0;
    if (wanted <= 0) return { credited: true, owed: false, doc: null, error: null };

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            // Built inside the guard, not above the loop: this function must
            // not reject — two sequential crew-payout loops and one
            // `Promise.all` over refunds depend on it, and one share that could
            // not be paid must not abandon the shares after it. Anything that
            // throws in here becomes an owed record like any other failure.
            const { status, doc } = await creditCoinsOnce(filter, wanted, payoutKey, {
                Model, extraSet: counterSetExpr(counters),
            });

            // 'duplicate' is a success: an earlier attempt landed and only its
            // response was lost. That is the case the key exists for, and the
            // reason this loop is allowed to exist at all.
            if (status === 'paid')      return { credited: true, owed: false, doc, error: null };
            if (status === 'duplicate') return { credited: true, owed: false, doc: null, error: null };

            lastError = new Error(
                status === 'missing'
                    ? `no user document to credit (${JSON.stringify(filter)})`
                    : `credit matched nothing but ${payoutKey} is absent`,
            );
            // A missing document will still be missing next time round, so
            // there is nothing to retry — go straight to recording it as owed.
            if (status === 'missing') break;
        } catch (err) {
            lastError = err;
        }
        if (attempt < attempts) await delay(attempt * 200);
    }

    console.error(
        `[${service}] ${jobName}: ${wanted} coins to ${filter.userId} in ${filter.guildId} ` +
        'could not be credited:', lastError?.message,
    );

    // `recordOwedPayout` documents that it never throws, and it does not. This
    // makes that a property of *this* function rather than a fact borrowed from
    // another module, because two sequential crew-payout loops and one
    // `Promise.all` over refunds all depend on this call never rejecting: one
    // share that could not be written down must not abandon the shares after it.
    const owed = await recordOwedPayout({
        service,
        jobName,
        guildId: filter.guildId ?? null,
        payload: {
            kind:      'coins',
            userId:    filter.userId,
            guildId:   filter.guildId,
            amount:    wanted,
            payoutKey,
            // The bookkeeping that was supposed to land with the credit. Without
            // it the replay pays the coins and leaves the counter where the
            // failed write left it — a duel refunded a week late by
            // `payouts:replay` would put the stake back and still count it as
            // gambled.
            ...(Object.keys(counters ?? {}).length ? { counters } : {}),
        },
        error: lastError,
    }).catch(err => {
        console.error(`[${service}] ${jobName}: recording the owed payout threw:`, err?.message);
        return false;
    });

    return { credited: false, owed, doc: null, error: lastError };
}

/**
 * Grants `quantity` of `itemId` exactly once, and records the grant as owed when
 * it will not land — `creditCoinsOrOwe` for the half of the economy that moves
 * items rather than coins.
 *
 * The item side had the same three bugs the coin side did, in the same order
 * (#873). `/market cancel` deletes the listing and then returns the stock with a
 * bare `grantInventoryItem`, reading the absence of a throw as success — but
 * that call answers `null` for a seller whose document has gone, so the reply
 * said "Returned 3x lucky_charm" over an item that no longer existed anywhere.
 * When it *did* throw, the listing was already gone, so there was nothing left
 * to find the return again and nothing written down: the item ended in a console
 * line. And `/gift`'s rollback — the write that hands a sender their item back
 * when the recipient's credit missed — ignored its return value entirely, so the
 * one case it exists to handle was the one it reported as handled.
 *
 * Same shape as the coin path for the same reasons: keyed, so the retry cannot
 * grant twice; retried, because a transient failure is the common one; and
 * filed as an owed payload `npm run payouts:replay` can settle when it still
 * will not land.
 *
 * `upsert` is off by default and passed through, because the two callers want
 * different answers. A return to a seller whose document was pruned is owed, not
 * a reason to resurrect the account; the expiry sweep upserts because a listing
 * outliving its seller's document is the case it was written for.
 *
 * @param {object}  filter            the user's `{ userId, guildId }`
 * @param {string}  itemId
 * @param {number}  quantity          a non-positive quantity is a no-op
 * @param {object}  opts
 * @param {string}  opts.payoutKey    names *this* grant, so neither the retry
 *                                    below nor a replayed record can grant twice
 * @param {string}  opts.service      for the owed record and the log line
 * @param {string}  opts.jobName
 * @param {object}  [opts.budgetRefund] a daily gift budget to give back in the
 *                                    same write, as
 *                                    `{ usedField, resetField, cap, amount, window }`.
 *                                    Carried onto the owed record too, so a
 *                                    replay reproduces the whole write rather
 *                                    than half of it — the same reason
 *                                    `creditCoinsOrOwe` carries `counters`. It
 *                                    is stated as a descriptor rather than a
 *                                    built expression because a `$`-keyed
 *                                    expression is not a thing to store in a
 *                                    document, and `window` is what lets the
 *                                    replay tell whether the allowance it would
 *                                    refund is still the one that was spent
 * @param {object}  [opts.extra]      further fields on the owed payload, for an
 *                                    operator reading the queue — a listing id,
 *                                    say. Not part of the write.
 * @param {boolean} [opts.upsert]
 * @param {number}  [opts.attempts]
 * @param {object}  [opts.Model]
 * @returns {Promise<{granted: boolean, owed: boolean, doc: ?object, error: ?Error}>}
 *
 * `granted: false` with `owed: true` means the item is neither in a bag nor lost
 * but written down for an operator to settle — the caller has to say so rather
 * than announcing a return that did not happen. Like `creditCoinsOrOwe`, this
 * never rejects: a caller unwinding a half-finished trade has other things left
 * to do, and a throw here would abandon them.
 */
async function grantItemsOrOwe(filter, itemId, quantity, {
    payoutKey, service = 'economy', jobName = 'grantItems', extra = {}, budgetRefund = null,
    upsert = false, attempts = DEFAULT_ATTEMPTS, Model = DEFAULT_USER,
} = {}) {
    const wanted = Math.floor(quantity) || 0;
    if (wanted <= 0) return { granted: true, owed: false, doc: null, error: null };

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            // The budget refund rides the guarded update, so it lands exactly
            // when the grant does — the key makes the retry a no-op, so it
            // cannot be applied twice by the loop.
            const { status, doc } = await grantItemOnce(
                filter, itemId, wanted, payoutKey,
                { upsert, extraSet: windowedRefundExpr(budgetRefund ?? {}), Model },
            );

            // 'duplicate' is a success: an earlier attempt landed and only its
            // response was lost. That is the case the key exists for.
            if (status === 'paid')      return { granted: true, owed: false, doc, error: null };
            if (status === 'duplicate') return { granted: true, owed: false, doc: null, error: null };

            lastError = new Error(
                status === 'missing'
                    ? `no user document to grant to (${JSON.stringify(filter)})`
                    : `grant matched nothing but ${payoutKey} is absent`,
            );
            // A missing document will still be missing next time round.
            if (status === 'missing') break;
        } catch (err) {
            lastError = err;
        }
        if (attempt < attempts) await delay(attempt * 200);
    }

    console.error(
        `[${service}] ${jobName}: ${wanted}x ${itemId} for ${filter.userId} in ${filter.guildId} ` +
        'could not be granted:', lastError?.message,
    );

    const owed = await recordOwedPayout({
        service,
        jobName,
        guildId: filter.guildId ?? null,
        payload: {
            kind:     'items',
            userId:   filter.userId,
            guildId:  filter.guildId,
            itemId,
            quantity: wanted,
            payoutKey,
            // The bookkeeping that was supposed to land with the item. Without
            // it the replay returns the item and leaves the allowance where the
            // failed write left it — a sender charged a day's cap for a gift
            // that never arrived.
            ...(budgetRefund ? { budgetRefund } : {}),
            ...extra,
        },
        error: lastError,
    }).catch(err => {
        console.error(`[${service}] ${jobName}: recording the owed payout threw:`, err?.message);
        return false;
    });

    return { granted: false, owed, doc: null, error: lastError };
}

module.exports = { creditCoinsOrOwe, grantItemsOrOwe, DEFAULT_ATTEMPTS };
