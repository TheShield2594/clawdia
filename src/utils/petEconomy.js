'use strict';

/**
 * The coins `/pet` moves, keyed (#873, pass 10).
 *
 * `/pet` has three currency-mutation paths the audit found on a bare, unkeyed
 * write: the wagered-battle winner payout, the escrow refunds when a wagered
 * battle does not happen, and the adoption fee handed back when a new pet cannot
 * be saved. Each was an `$inc` that read nothing back and told the player the
 * coins had moved regardless — the durability gap the coin helpers close
 * everywhere else. This is the thin wrapper that routes them through
 * `creditCoinsOrOwe`, the same shape `utils/duelEscrow.js` gives `/duel`.
 *
 * The battle stakes stay as they are: each is a guarded compare-and-set whose
 * result is read in the same handler before anything else happens, so by the
 * time a refund or a payout runs the debit is known to have landed. That makes
 * an unconditional keyed credit the correct compensation — the "taken moments
 * ago in this same call" case `rollbackStake` documents — so, unlike `/duel`,
 * this needs no keyed debit. The only thing missing was reading the credit back
 * and writing it down when it did not land, which is what these add.
 */

const { creditCoinsOrOwe } = require('./creditOrOwe');
const {
    petBattlePayoutKey, petBattleRefundPayoutKey, petAdoptRefundPayoutKey,
} = require('./payoutKey');

/**
 * Pays the pot to a wagered battle's winner, on its own keyed write.
 *
 * No `lifetimeGambled` counter: a pet battle does not advance it today (the
 * badge counters are a separate, non-coin question left out of this pass), and
 * winnings are not a wager in any case.
 */
function payBattleWinner(winnerId, guildId, payout, battleId) {
    return creditCoinsOrOwe({ userId: winnerId, guildId }, payout, {
        payoutKey: petBattlePayoutKey(battleId, winnerId),
        service: 'pet', jobName: 'petBattlePayout',
    });
}

/**
 * Hands one escrowed stake back, keyed, and says whether it arrived.
 *
 * Never rejects — `creditCoinsOrOwe` does not — so a caller unwinding a battle
 * that a paired refund also has to finish is safe to await both.
 */
function refundBattleStake(userId, guildId, amount, battleId, jobName = 'petBattleRefund') {
    return creditCoinsOrOwe({ userId, guildId }, amount, {
        payoutKey: petBattleRefundPayoutKey(battleId, userId),
        service: 'pet', jobName,
    });
}

/**
 * Hands both escrowed stakes back and reports which of them actually arrived.
 *
 * Independent credits under separate keys, so one failing must not cancel the
 * other, and both are already on an error path.
 */
async function refundBothStakes(challengerId, opponentId, guildId, amount, battleId) {
    const [challenger, opponent] = await Promise.all([
        refundBattleStake(challengerId, guildId, amount, battleId),
        refundBattleStake(opponentId,   guildId, amount, battleId),
    ]);
    return {
        refunded: challenger.credited && opponent.credited,
        owed: (!challenger.credited && challenger.owed) || (!opponent.credited && opponent.owed),
    };
}

/** What to tell both players about a two-stake refund that was attempted. */
function battleRefundNote(returned) {
    if (returned.refunded) return ' Both wagers have been refunded.';
    // "At least one", because one of the two may well have landed — saying the
    // refund failed outright would read as a loss to the player who got theirs.
    return returned.owed
        ? ' At least one wager could not be returned — the amount is recorded and an admin can restore it.'
        : ' At least one wager could not be returned. Please contact a server admin.';
}

/** What to tell one player about their own stake coming back. */
function stakeRefundNote(back) {
    if (back.credited) return ' Your wager was refunded.';
    return back.owed
        ? ' Your wager could not be returned right now — it is recorded and an admin can restore it.'
        : ' Your wager could not be returned. Please contact a server admin.';
}

/** Hands the adoption fee back, keyed, when the pet could not be saved. */
function refundAdoptFee(userId, guildId, amount, interactionId) {
    return creditCoinsOrOwe({ userId, guildId }, amount, {
        payoutKey: petAdoptRefundPayoutKey(interactionId),
        service: 'pet', jobName: 'petAdoptRefund',
    });
}

/** How to word the adoption-fee refund from what it actually did. */
function adoptRefundNote(back) {
    if (back.credited) return 'your coins were refunded';
    return back.owed
        ? 'your coins are recorded as owed and an admin can restore them'
        : 'your coins could not be returned — please contact a server admin';
}

module.exports = {
    payBattleWinner,
    refundBattleStake, refundBothStakes, battleRefundNote, stakeRefundNote,
    refundAdoptFee, adoptRefundNote,
};
