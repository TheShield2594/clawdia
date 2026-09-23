'use strict';

/**
 * Handing back duel stakes a restart stranded (#873, the duel restart sweep).
 *
 * `/duel` takes both stakes into escrow at accept and then lives only in
 * in-memory collectors: the move window of rock-paper-scissors, or the instant
 * games' `finalizeDuel`. A process that dies in between settles nothing — no
 * winner is paid, no stake is refunded — and nothing ever looked again. The
 * escrow keys on the two user documents are the only record, and they are
 * evicted after 24 hours (`RETENTION_HOURS` in utils/debitKey.js), after which
 * even an operator could not reverse them.
 *
 * Every accepted duel now leaves a `PendingDuel`. This sweep reads the ones
 * older than any live duel can be and asks whether the duel settled. The hard
 * part is that "an escrow still standing" is not "stranded": a duel that was won
 * leaves the loser's escrow standing forever, because the pot is paid to the
 * winner as a credit, not by reversing anyone's debit. So a duel counts as
 * settled when any of these exist for it:
 *
 *   - a `duel:{duelId}:…` key in either player's `paidPayouts` — the winner's
 *     payout, or a tie's or a timeout's refunds (`returnStake` credits under
 *     `duelPayoutKey(…, 'refund')`, it does not reverse the debit);
 *   - an owed-payout record filed under such a key — a payout or refund that
 *     failed and is waiting for `payouts:replay`. Handing the stakes back as
 *     well would pay that duel twice.
 *
 * Only a duel with none of them is stranded, and its standing escrow entries
 * are reversed. A reversed entry is not a sign the duel settled: `takeEscrow`
 * reverses the challenger's stake when the opponent's cannot be taken, and when
 * the opponent's own rollback could not be confirmed its entry is still
 * standing, owed back, with the reversed one beside it. Standing entries are
 * reversed through `undoStake`: conditional on the key being there and
 * un-reversed, so it cannot mint and cannot pay twice however many sweeps race.
 *
 * Nobody is told on Discord — the channel may be gone. The refund is in the
 * ledger (`duel_refund`, noted as a restart refund) and in the log.
 */

const User = require('../models/User');
const PendingDuel = require('../models/PendingDuel');
const FailedJob = require('../models/FailedJob');
const { duelEscrowKey, undoStake } = require('../utils/duelEscrow');
const { logTransaction } = require('../utils/logTransaction');
const { handlesGuild } = require('../utils/sharding');

/**
 * How old an entry has to be before the sweep may judge it. A live duel is
 * settled within about two and a half minutes of accept (a 60-second move
 * window, then 30-second ones, then `finalizeDuel`); ten leaves room for a slow
 * settlement without ever reversing one that is still running.
 */
const STRANDED_AFTER_MS = 10 * 60 * 1000;

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether this duel left any record of settling. */
async function settled(pending, docs) {
    const prefix = `duel:${pending.duelId}:`;
    for (const doc of docs) {
        if ((doc.paidPayouts ?? []).some(p => typeof p?.key === 'string' && p.key.startsWith(prefix))) return true;
    }
    const owed = await FailedJob.findOne(
        { 'payload.payoutKey': { $regex: `^${escapeRegex(prefix)}` } },
        '_id',
    ).lean();
    return Boolean(owed);
}

/**
 * Settle one pending duel.
 *
 * @returns {Promise<'settled' | 'refunded' | 'retry'>} `retry` keeps the entry
 *   for the next sweep: a reversal whose write could not be made.
 */
async function settleOne(pending) {
    const { duelId, guildId, amount } = pending;
    const ids = [pending.challengerId, pending.opponentId];
    const docs = await User.find(
        { guildId, userId: { $in: ids } },
        'userId balance paidPayouts spentDebits',
    ).lean();

    if (await settled(pending, docs)) return 'settled';

    let outcome = 'settled';
    for (const doc of docs) {
        const entry = (doc.spentDebits ?? []).find(d => d?.key === duelEscrowKey(duelId, doc.userId));
        // No escrow of theirs standing: never taken, or evicted with the window.
        if (!entry || entry.reversed === true) continue;

        const back = await undoStake(doc.userId, guildId, amount, duelId);
        if (!back.resolved) { outcome = 'retry'; continue; }
        if (!back.reversed) continue; // another sweep got there first

        outcome = outcome === 'retry' ? 'retry' : 'refunded';
        logTransaction({
            userId: doc.userId, guildId, type: 'duel_refund', amount,
            balance: back.doc.balance,
            relatedUserId: ids.find(id => id !== doc.userId) ?? null,
            note: `bot restart refund — duel ${duelId}`,
        });
        console.warn(`[duel] returned a stranded ${amount} stake to ${doc.userId} in ${guildId} (duel ${duelId})`);
    }
    return outcome;
}

/**
 * Sweep every pending duel old enough to judge, in the guilds this shard owns.
 * A failure on one is logged and the sweep moves on; its entry stays for the
 * next run.
 *
 * @returns {Promise<{refunded: number, settled: number, failed: number}>}
 */
async function sweepStrandedDuels(client = null, { now = Date.now() } = {}) {
    const due = await PendingDuel.find({ createdAt: { $lte: new Date(now - STRANDED_AFTER_MS) } }).lean();

    const tally = { refunded: 0, settled: 0, failed: 0 };
    for (const pending of due) {
        if (!handlesGuild(pending.guildId, client)) continue;
        try {
            const outcome = await settleOne(pending);
            if (outcome === 'retry') { tally.failed++; continue; }
            tally[outcome]++;
            await PendingDuel.deleteOne({ _id: pending._id });
        } catch (err) {
            tally.failed++;
            console.error(`[duel] stranded-stake sweep failed for duel ${pending.duelId} in ${pending.guildId}:`, err);
        }
    }
    return tally;
}

/**
 * Note a duel whose stakes are about to be escrowed. Best effort: a duel whose
 * note could not be written still runs, it just has no sweep behind it — which
 * is where every duel stood before this existed.
 */
async function notePendingDuel({ duelId, guildId, challengerId, opponentId, amount }) {
    try {
        await PendingDuel.create({ duelId, guildId, challengerId, opponentId, amount });
    } catch (err) {
        console.error(`[duel] could not note pending duel ${duelId}; a restart mid-duel would strand its stakes:`, err.message);
    }
}

module.exports = { sweepStrandedDuels, notePendingDuel, STRANDED_AFTER_MS };
