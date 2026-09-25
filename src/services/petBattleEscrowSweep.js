'use strict';

/**
 * Handing back pet-battle stakes a restart stranded (#1184).
 *
 * A wagered member battle takes both stakes and then runs up to three stance
 * rounds, a minute or more held only in memory collectors. A process that dies
 * in that window pays nobody and refunds nobody. This is the same answer
 * `/duel` has (services/duelEscrowSweep.js): every battle leaves a
 * `PendingPetBattle` naming the stakes that landed, and this sweep settles the
 * ones old enough that no live battle can own them.
 *
 * A battle counts as settled when either player carries a
 * `pet:battle:{battleId}:` payout key — the winner's pot or a refund — or an
 * owed-payout record is filed under one, waiting for `payouts:replay`. Only a
 * battle with none of them is stranded, and each recorded stake goes back
 * through `refundBattleStake`, keyed, so a second sweep or a late settlement
 * cannot pay it twice.
 */

const User = require('../models/User');
const FailedJob = require('../models/FailedJob');
const PendingPetBattle = require('../models/PendingPetBattle');
const { refundBattleStake } = require('../utils/petEconomy');
const { logTransaction } = require('../utils/logTransaction');
const { handlesGuild } = require('../utils/sharding');

/** Well past the longest live battle: a minute and a half of rounds after the stakes. */
const STRANDED_AFTER_MS = 10 * 60 * 1000;

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function settled(pending) {
    const prefix = `pet:battle:${pending.battleId}:`;
    const docs = await User.find(
        { guildId: pending.guildId, userId: { $in: [pending.challengerId, pending.opponentId] } },
        'userId paidPayouts',
    ).lean();
    for (const doc of docs) {
        if ((doc.paidPayouts ?? []).some(p => typeof p?.key === 'string' && p.key.startsWith(prefix))) return true;
    }
    const owed = await FailedJob.findOne({ 'payload.payoutKey': { $regex: `^${escapeRegex(prefix)}` } }, '_id').lean();
    return Boolean(owed);
}

/**
 * Settle one pending battle.
 * @returns {Promise<'settled'|'refunded'|'retry'>}
 */
async function settleOne(pending) {
    if (await settled(pending)) return 'settled';
    let outcome = 'settled';
    for (const userId of new Set(pending.stakes ?? [])) {
        const back = await refundBattleStake(userId, pending.guildId, pending.amount, pending.battleId, 'petBattleRestartRefund');
        // Owed is as good as done here: it is filed under the battle's key.
        if (!back.credited && !back.owed) { outcome = 'retry'; continue; }
        if (outcome !== 'retry') outcome = 'refunded';
        if (back.credited) {
            logTransaction({
                userId, guildId: pending.guildId, type: 'pet_battle', amount: pending.amount,
                balance: back.doc?.balance ?? null,
                relatedUserId: userId === pending.challengerId ? pending.opponentId : pending.challengerId,
                note: `bot restart refund — pet battle ${pending.battleId}`,
            });
        }
        console.warn(`[pet battle] returned a stranded ${pending.amount} stake to ${userId} in ${pending.guildId} (battle ${pending.battleId})`);
    }
    return outcome;
}

/**
 * Sweep every pending battle old enough to judge, in this shard's guilds.
 * @returns {Promise<{refunded: number, settled: number, failed: number}>}
 */
async function sweepStrandedPetBattles(client = null, { now = Date.now() } = {}) {
    const due = await PendingPetBattle.find({ createdAt: { $lte: new Date(now - STRANDED_AFTER_MS) } }).lean();
    const tally = { refunded: 0, settled: 0, failed: 0 };
    for (const pending of due) {
        if (!handlesGuild(pending.guildId, client)) continue;
        try {
            const outcome = await settleOne(pending);
            if (outcome === 'retry') { tally.failed++; continue; }
            tally[outcome]++;
            await PendingPetBattle.deleteOne({ _id: pending._id });
        } catch (err) {
            tally.failed++;
            console.error(`[pet battle] stranded-stake sweep failed for battle ${pending.battleId}:`, err);
        }
    }
    return tally;
}

/**
 * Note a stake that has just been taken. Best effort, as `notePendingDuel` is:
 * a battle whose note could not be written still runs, without a sweep behind it.
 */
async function notePetStake({ battleId, guildId, challengerId, opponentId, amount }, userId) {
    try {
        await PendingPetBattle.updateOne(
            { battleId },
            { $setOnInsert: { guildId, challengerId, opponentId, amount, createdAt: new Date() }, $addToSet: { stakes: userId } },
            { upsert: true },
        );
    } catch (err) {
        console.error(`[pet battle] could not note the stake for battle ${battleId}; a restart mid-battle would strand it:`, err.message);
    }
}

/** Drop a battle's note once it has settled in the ordinary way. Best effort; the sweep deletes it otherwise. */
async function clearPendingPetBattle(battleId) {
    await PendingPetBattle.deleteOne({ battleId }).catch(() => {});
}

module.exports = { sweepStrandedPetBattles, notePetStake, clearPendingPetBattle, STRANDED_AFTER_MS };
