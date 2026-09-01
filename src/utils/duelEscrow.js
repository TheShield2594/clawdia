'use strict';

/**
 * Where a duel's coins are while the duel is happening.
 *
 * Both stakes leave their owners the moment the challenge is accepted and do
 * not belong to anybody until it resolves, which makes this the only place in
 * the economy where coins exist outside a balance. Getting a step wrong here
 * does not misreport a number — it makes or unmakes one, and #873 found three
 * ways it could. It lives beside the rest of the money helpers rather than
 * inside the command, because none of it is about buttons or embeds.
 */

const User = require('../models/User');
const { creditCoinsOrOwe } = require('./creditOrOwe');
const { duelPayoutKey } = require('./payoutKey');

// Atomically deduct wagers from both players. Returns { success, reason, returned }.
//
// The stake also advances `lifetimeGambled`, the counter behind Lucky, Gambler,
// High Roller and the three Wager badges. A duel is a coin bet on a coin flip
// dressed up as rock-paper-scissors, and it is the only wager outside the
// casino that puts a player's own coins at risk on an outcome — leaving it out
// meant those achievements measured "coins staked at /casino" while claiming to
// measure coins gambled. Every path that hands a stake back for a duel that
// never happened (both branches here, and refundEscrow) takes the counter back
// with it, so a declined or expired duel counts for nothing.
//
// The rollback when the opponent's stake cannot be taken used to be a bare
// `await User.updateOne(...)`: unchecked, so an update that matched no document
// looked exactly like one that moved coins, and unguarded, so a rejection
// travelled out to a caller that had already decided no escrow was taken and
// refunded nothing. Either way the challenger's stake was simply gone (#873).
// It goes through the same credit-or-write-it-down path as every other refund
// here now, and what actually happened comes back with the result.
async function takeEscrow(challengerId, opponentId, guildId, amount, duelId) {
    const challenger = await User.findOneAndUpdate(
        { userId: challengerId, guildId, balance: { $gte: amount } },
        { $inc: { balance: -amount, lifetimeGambled: amount } },
        { new: true }
    );
    if (!challenger) return { success: false, reason: 'challenger', returned: null };

    // The second debit is wrapped because the first one has already committed —
    // it returned a document — and a rejection here used to travel out to a
    // caller whose `escrowTaken` was still false, so nothing refunded the
    // challenger. A stake known to have left an account is reconciled here
    // rather than left to a handler that does not know it exists (#873).
    //
    // Note what this does *not* cover: a rejection from either debit whose own
    // outcome is unknown — the write may have committed and lost its response.
    // Refunding on that would mint coins for a debit that never landed, so it
    // needs a keyed debit the way credits already have one, which is a larger
    // change than this. See the PR discussion.
    let opponent;
    try {
        opponent = await User.findOneAndUpdate(
            { userId: opponentId, guildId, balance: { $gte: amount } },
            { $inc: { balance: -amount, lifetimeGambled: amount } },
            { new: true }
        );
    } catch (err) {
        console.error(`[duel] opponent escrow for ${opponentId} in ${guildId} failed:`, err.message);
        const back = await returnStake(challengerId, guildId, amount, duelId, 'escrowRollback');
        return {
            success: false,
            reason: 'error',
            returned: { refunded: back.credited, owed: back.owed },
        };
    }
    if (!opponent) {
        const back = await returnStake(challengerId, guildId, amount, duelId, 'escrowRollback');
        return {
            success: false,
            reason: 'opponent',
            returned: { refunded: back.credited, owed: back.owed },
        };
    }
    return { success: true, returned: null };
}

/**
 * Hands one escrowed stake back, and says whether it arrived.
 *
 * `unwager` is what separates the two reasons a stake comes back. A duel that
 * never happened — declined, expired, errored, or an escrow that could only
 * take one of the two stakes — has to take `lifetimeGambled` back with the
 * coins, or a player would be credited for coins they got straight back. A tie
 * is not that: the duel was fought and the stakes were at risk, exactly as a
 * blackjack push is, and the counter stays.
 *
 * The whole thing is one write, so the counter cannot be reversed for a refund
 * that did not land — and when the refund cannot land at all it is recorded as
 * owed, counter included, so a replay a week later puts back the same two
 * things this write would have.
 */
function returnStake(userId, guildId, amount, duelId, jobName, { unwager = true } = {}) {
    return creditCoinsOrOwe({ userId, guildId }, amount, {
        payoutKey: duelPayoutKey(duelId, userId, 'refund'),
        service: 'duel',
        jobName,
        counters: unwager ? { lifetimeGambled: -amount } : {},
    });
}

// Hands both escrowed stakes back, and reports which of them actually arrived.
// Never rejects: both credits are independent, so one failing must not cancel
// the other, and every caller is already on an error path where losing the
// refund to a second error would be the worse outcome.
//
// Keyed per duel and player, which makes a second call for the same duel a
// no-op rather than a second refund. `settled` in runRPS is what is supposed to
// stop that happening; the key is what makes it not matter if it ever does not.
async function refundEscrow(challengerId, opponentId, guildId, amount, duelId, opts) {
    const [challenger, opponent] = await Promise.all([
        returnStake(challengerId, guildId, amount, duelId, 'escrowRefund', opts),
        returnStake(opponentId,   guildId, amount, duelId, 'escrowRefund', opts),
    ]);
    return {
        refunded: challenger.credited && opponent.credited,
        owed: (!challenger.credited && challenger.owed) || (!opponent.credited && opponent.owed),
    };
}

// What to tell the players about a refund that was attempted. All seven of
// /duel's refund messages used to end in "Both bets have been refunded."
// whatever the two writes did, which is the sentence a player reads instead of
// checking their balance.
function refundNote(returned) {
    if (returned.refunded) return ' Both bets have been refunded.';
    // "At least one", because one of the two may well have landed — saying the
    // refund failed outright would read as a loss to the player who got theirs.
    return returned.owed
        ? ' At least one bet could not be returned — the amount is recorded and an admin can restore it.'
        : ' At least one bet could not be returned. Please contact a server admin.';
}

/**
 * Pays the pot to the winner, on its own write.
 *
 * Not folded in with the win record: `duelWins` and an ELO rating are
 * bookkeeping — losing one costs a number on a profile — while the pot is both
 * players' stakes and has nowhere else to be. Keeping them apart means the
 * money has a result that can be checked and a failure that can be written
 * down, instead of sharing the fate of a `$set` on a ranked counter.
 *
 * No `lifetimeGambled` here: the stake was counted when it was escrowed, and
 * winnings are not a wager.
 */
function payWinner(winnerId, guildId, payout, duelId) {
    return creditCoinsOrOwe({ userId: winnerId, guildId }, payout, {
        payoutKey: duelPayoutKey(duelId, winnerId, 'payout'),
        service: 'duel', jobName: 'duelPayout',
    });
}

module.exports = { takeEscrow, refundEscrow, returnStake, payWinner, refundNote };
