'use strict';

/**
 * Paying out a settled casino hand, durably.
 *
 * Every credit under `src/games/casino` was a bare `$inc` with nothing around
 * it (#873):
 *
 *     const updated = await User.findOneAndUpdate(filter, { $inc: { balance: payout } }, { new: true });
 *     // ...then an embed announcing `payout`, using `updated?.balance ?? 0`
 *
 * `src/utils/economyLock.js` argues that this is safe, and for the property it
 * was arguing about it is: a `$inc` is atomic, so a hand settling while a grind
 * command runs cannot lose a payout to a stale read. But atomic is not durable.
 * A `$inc` that never lands — a stepdown, a socket reset, a filter that matches
 * nothing because the document was removed between the wager and the
 * settlement — leaves no trace at all, and the stake was taken minutes earlier
 * by `placeWager`. The player is out the bet *and* the winnings, and the only
 * record is a balance figure in an embed that was already going to be printed.
 *
 * Some of those writes had no `.catch` either, sitting in a collector's `end`
 * handler where a rejection becomes an unhandled rejection and takes the final
 * embed and the lock release down with it — the hand simply stops, mid-reveal.
 *
 * The progressive jackpot, credited from `casinoJackpotService` a few lines
 * away from the spin that won it, already does this properly: keyed, retried,
 * and written down as owed when it will not land. That asymmetry is the bug —
 * the pot built from other players' stakes is recoverable, and the hand's own
 * payout beside it is not.
 *
 * So the hand payout goes through the same helper. `creditCoinsOrOwe`
 * documents that it never rejects, which is what lets these calls sit
 * unguarded in a collector callback: a payout that cannot be credited becomes
 * an owed record for `npm run payouts:replay` instead of an unhandled
 * rejection, and the caller is told so it can say so rather than printing a
 * balance that never changed.
 */

const { randomUUID } = require('crypto');
const User = require('../../models/User');
const { creditCoinsOrOwe } = require('../../utils/creditOrOwe');
const { casinoPayoutKey } = require('../../utils/payoutKey');

/**
 * A fresh identifier for one hand.
 *
 * Not the interaction's id, which is the obvious choice and the wrong one:
 * every game's "Play Again" button re-enters its play function with the
 * *original* interaction, so a second hand would carry the first hand's id.
 * Keyed on that, the replay's payout would be classified as a duplicate of a
 * payout that had already landed and silently dropped — the player wins and is
 * not paid, which is worse than the unkeyed write this replaces.
 *
 * Minted once per hand and threaded through the recursion inside one (Monte's
 * double-or-nothing rounds, higher-or-lower's streak), because those are the
 * same hand and must share a key space; a replay calls the play function again
 * and so gets a new one.
 */
function newHandId() {
    return randomUUID();
}

/**
 * Credits one settlement of one hand, exactly once.
 *
 * @param {object} filter   the player's `{ userId, guildId }`
 * @param {number} amount   coins to credit; a non-positive amount is a no-op
 * @param {object} opts
 * @param {string} opts.game    the game's name, for the key and the log line
 * @param {string} opts.handId  from `newHandId`, minted once per hand — stable
 *                              across it, so a retry rebuilds the same key
 * @param {string} opts.phase   which settlement of the hand this is
 * @param {object} [opts.counters]  further counters to move with the credit
 * @returns {Promise<{credited: boolean, owed: boolean, balance: ?number}>}
 *
 * `balance` is the balance after the credit when that is known, and `null` when
 * it is not — a duplicate credit returns no document, and neither does a
 * payout that was written down as owed. Callers show `null` as the balance they
 * last read rather than as zero: a hand that failed to pay has not emptied the
 * player's wallet, and printing 0 would say it had.
 */
async function payHand(filter, amount, { game, handId, phase, counters = {} } = {}) {
    const { credited, owed, doc } = await creditCoinsOrOwe(filter, amount, {
        payoutKey: casinoPayoutKey(game, handId, phase),
        service:   'casino',
        jobName:   `${game}:${phase}`,
        counters,
    });

    // A no-op credit (a loss, or a zero payout) reports the balance as unknown
    // rather than reading the document for it: nothing moved, so the caller's
    // own figure is already the right one and a round trip would only add a way
    // for the settlement to fail.
    return { credited, owed, balance: doc?.balance ?? null };
}

/**
 * The sentence a hand adds to its result when the payout could not be credited.
 *
 * Empty when the coins landed, so the caller can append it unconditionally.
 * A player whose payout is owed has to be told — the alternative is an embed
 * that announces winnings and a balance that did not move, which reads as the
 * bot having stolen the hand.
 */
function payoutNote({ credited, owed }) {
    if (credited) return '';
    return owed
        ? '\n⚠️ The payout could not be credited right now. It has been recorded and will be paid automatically.'
        : '\n⚠️ The payout could not be credited and could not be recorded. Please contact a server admin.';
}

/**
 * The balance to print after a settlement: the one the credit returned, or the
 * player's own document read back when it did not return one.
 *
 * Reading rather than falling back to a pre-hand figure matters on the owed
 * path: the stake left the wallet when the wager was placed, so the last
 * balance the game held is higher than the truth, and showing it would tell a
 * player who has *not* been paid that they have been.
 */
async function settledBalance(filter, balance) {
    if (balance !== null && balance !== undefined) return balance;
    // try/catch rather than `.catch()`: this runs on the path where a write has
    // already failed, which is not the moment to assume the next call to the
    // same database returns a well-formed query to chain onto. A throw here
    // would take down the embed that is trying to explain the failure.
    try {
        const fresh = await User.findOne(filter, 'balance').lean();
        return fresh?.balance ?? 0;
    } catch {
        return 0;
    }
}

module.exports = { newHandId, payHand, payoutNote, settledBalance };
