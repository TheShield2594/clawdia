'use strict';

const User = require('../models/User');

/**
 * Takes a wager off a player — and, for the wager that opens a hand, says so.
 *
 * Two things used to be true of casino bets and neither was good.
 *
 * The first is that every game wrote its own debit. All eight had the same
 * compare-and-set — `balance: { $gte: bet }` in the filter, `$inc` in the update,
 * null means the coins moved and the hand must not start — copied out by hand,
 * some of them five times over for insurance, splits, raises and rerolls. That
 * filter *is* the anti-duplication defence, so eight independent copies of it is
 * eight chances to get it subtly wrong.
 *
 * The second is that nothing downstream could tell whether a bet had actually
 * been placed. `casino.js` took "the player typed a number above zero" as its
 * signal, and fired the progressive jackpot contribution and the "Play 5 casino
 * games" season mission on it — before `game.execute` had validated anything. A
 * bet larger than the wallet, or over the guild's `casinoMaxBet`, or refused for
 * any other reason still grew the jackpot pool and still ticked the mission, for
 * a hand that never happened.
 *
 * So the debit reports back. `onWager` fires only once the money has actually
 * moved, and only for the wager that opens a hand: a double-down, an insurance
 * side bet, a poker raise and a keno reroll all go through the same helper
 * without it, because they are more money on a hand already counted — not
 * another game played.
 *
 * The third thing is that nothing counted the coins. `lifetimeGambled` is what
 * the six wagering achievements (Lucky, Gambler, High Roller and the three
 * Wager tiers) read, and only blackjack ever wrote it — the other seven games
 * debited a stake through this helper and left the counter untouched, so a
 * player could lose a million coins at slots and still show 0 progress toward
 * High Roller. It is written here now, for the same reason the debit
 * lives here: a stake that moved is a stake that was gambled, and there is
 * exactly one place that knows the coins moved.
 *
 * Unlike `onWager`, it counts *every* stake and not just the opening one — a
 * double-down, an insurance side bet, a poker raise and a keno reroll are all
 * more coins put at risk, which is what the achievement measures, even though
 * they are not another game played. That is the same rule blackjack already
 * applied to its own five sites, kept and extended rather than narrowed.
 *
 * @param {object} filter          the user's `{ userId, guildId }`
 * @param {number} amount          coins to take
 * @param {object} [opts]
 * @param {object} [opts.extraInc] further `$inc` fields for the same write, so a
 *                                 stake and its bookkeeping commit together
 * @param {Function} [opts.onWager] called with `{ amount, user, source, doc }`
 *                                 when this debit opened a hand and landed
 * @param {object} [opts.user]     who placed it, if not the command's invoker —
 *                                 a crash lobby takes bets from joiners too
 * @param {object} [opts.source]   the interaction to announce a jackpot through
 * @returns {Promise<object|null>} the updated user document, or null if the
 *                                 coins were gone by the time the write landed
 */
async function placeWager(filter, amount, { extraInc = {}, onWager = null, user = null, source = null } = {}) {
    const wager = Math.floor(amount);
    if (!(wager > 0)) return null;

    const debited = await User.findOneAndUpdate(
        { ...filter, balance: { $gte: wager } },
        { $inc: { balance: -wager, lifetimeGambled: wager, ...extraInc } },
        { new: true },
    );

    // Fire-and-forget by contract: the caller is mid-hand and the jackpot and
    // mission writes are both best-effort, so a slow round trip must not hold
    // up dealing the cards. The debited document rides along so a listener can
    // read the counters this write just advanced without a second round trip.
    if (debited && onWager) onWager({ amount: wager, user, source, doc: debited });

    return debited;
}

module.exports = { placeWager };
