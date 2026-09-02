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

const { creditCoinsOrOwe } = require('./creditOrOwe');
const { duelPayoutKey } = require('./payoutKey');
const { debitCoinsOrKnow, reverseKeyedDebit } = require('./debitKey');

/**
 * Names one player's stake in one duel, for the debit that takes it.
 *
 * Separate from `duelPayoutKey`: that keys the credits a duel can owe, and this
 * keys the debits it takes. They live on different arrays and answer different
 * questions, and a shared string would let one silently satisfy the other.
 */
function duelEscrowKey(duelId, userId) {
    return `duel:${duelId}:escrow:${userId}`;
}

/**
 * Takes one player's stake, keyed, and reports a state rather than a document.
 *
 * `lifetimeGambled` moves in the same write for the reason it always has: a
 * stake that moved is a stake that was gambled, and there is exactly one place
 * that knows the coins moved.
 */
function takeStake(userId, guildId, amount, duelId) {
    return debitCoinsOrKnow({ userId, guildId }, amount, duelEscrowKey(duelId, userId), {
        counters: { lifetimeGambled: amount },
    });
}

/**
 * Undoes a stake whose debit may or may not have happened.
 *
 * The conditional compensation from src/utils/debitKey.js, and the reason this
 * module no longer has a case it cannot handle: it credits back only against a
 * recorded debit, so calling it without knowing whether the debit landed is
 * safe. `returnStake` below is still the right tool when the debit is *known* to
 * have landed — it is an unconditional credit with the owed-payout ledger behind
 * it, which this deliberately is not.
 */
function undoStake(userId, guildId, amount, duelId) {
    return reverseKeyedDebit({ userId, guildId }, amount, duelEscrowKey(duelId, userId), {
        counters: { lifetimeGambled: -amount },
    });
}

/**
 * The debit outcomes that mean "this player cannot cover the stake", as opposed
 * to "something went wrong". A member with no document has no coins, so it
 * belongs with the other two.
 */
const SHORT_STATUSES = new Set(['insufficient', 'frozen', 'missing']);

/**
 * Atomically deducts both players' wagers. Returns `{ success, reason, returned }`.
 *
 * The stake also advances `lifetimeGambled`, the counter behind Lucky, Gambler,
 * High Roller and the three Wager badges. A duel is a coin bet on a coin flip
 * dressed up as rock-paper-scissors, and it is the only wager outside the
 * casino that puts a player's own coins at risk on an outcome — leaving it out
 * meant those achievements measured "coins staked at /casino" while claiming to
 * measure coins gambled. Every path that hands a stake back for a duel that
 * never happened takes the counter back with it, so a declined or expired duel
 * counts for nothing.
 *
 * The rollback when the opponent's stake cannot be taken used to be a bare
 * `await User.updateOne(...)`: unchecked, so an update that matched no document
 * looked exactly like one that moved coins, and unguarded, so a rejection
 * travelled out to a caller that had already decided no escrow was taken and
 * refunded nothing. Either way the challenger's stake was simply gone (#873).
 *
 * What #873 could not close was the debit whose *own* outcome was unknown — a
 * write that may have committed and lost its response. Refunding it would mint
 * coins for a debit that never landed; not refunding it would destroy coins for
 * one that did. Both stakes are keyed now (#969), which turns that into a
 * question the document can answer: `takeStake` retries and then reads the key,
 * and `undoStake` compensates against the key rather than against a guess, so it
 * is a no-op for a debit that never happened. There is no branch below that can
 * make or unmake a coin.
 */
async function takeEscrow(challengerId, opponentId, guildId, amount, duelId) {
    const challenger = await takeStake(challengerId, guildId, amount, duelId);

    // The database could not be reached even to ask whether the debit landed.
    // Compensating blind is safe here and nowhere else: `undoStake` matches only
    // a recorded debit, so it gives the stake back if it was taken and does
    // nothing at all if it was not.
    if (!challenger.resolved) {
        const back = await undoStake(challengerId, guildId, amount, duelId);
        console.error(`[duel] challenger escrow for ${challengerId} in ${guildId} was indeterminate:`, challenger.error?.message);
        return {
            success: false,
            reason: 'error',
            // `refunded` here means "no coins are missing", which covers both a
            // stake given back and a stake that never left.
            returned: { refunded: back.resolved, owed: false },
        };
    }

    if (!challenger.debited) {
        return {
            success: false,
            // Only the three that are actually about the player's wallet are
            // reported as the player being short. A write that matched nothing
            // it should have matched, or one that never landed, is a fault —
            // and saying "you no longer have enough" would send them off to
            // check a balance that is fine.
            reason: SHORT_STATUSES.has(challenger.status) ? 'challenger' : 'error',
            returned: null,
        };
    }

    const opponent = await takeStake(opponentId, guildId, amount, duelId);
    if (opponent.debited) return { success: true, returned: null };

    // From here the challenger's stake is known to have left, so it has to come
    // back whatever happened to the opponent's. The opponent's own stake is
    // undone first and unconditionally: if their debit landed, this returns it;
    // if it did not, this does nothing.
    if (!opponent.resolved) {
        console.error(`[duel] opponent escrow for ${opponentId} in ${guildId} was indeterminate:`, opponent.error?.message);
    }
    await undoStake(opponentId, guildId, amount, duelId);

    const back = await returnStake(challengerId, guildId, amount, duelId, 'escrowRollback');
    return {
        success: false,
        // Same rule as above: 'opponent' is a verdict on their wallet, and
        // nothing else may be reported as one.
        reason: SHORT_STATUSES.has(opponent.status) ? 'opponent' : 'error',
        returned: { refunded: back.credited, owed: back.owed },
    };
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

/**
 * Hands both escrowed stakes back, and reports which of them actually arrived.
 *
 * Never rejects: both credits are independent, so one failing must not cancel
 * the other, and every caller is already on an error path where losing the
 * refund to a second error would be the worse outcome.
 *
 * Keyed per duel and player, which makes a second call for the same duel a
 * no-op rather than a second refund. `settled` in runRPS is what is supposed to
 * stop that happening; the key is what makes it not matter if it ever does not.
 */
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

/**
 * What to tell the players about a refund that was attempted.
 *
 * All seven of `/duel`'s refund messages used to end in "Both bets have been
 * refunded." whatever the two writes did, which is the sentence a player reads
 * instead of checking their balance.
 */
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

module.exports = {
    takeEscrow, refundEscrow, returnStake, payWinner, refundNote,
    duelEscrowKey, takeStake, undoStake,
};
