'use strict';

const FishingTournament = require('../models/FishingTournament');
const { EmbedBuilder } = require('discord.js');

const PRIZE_SPLITS = [0.60, 0.25, 0.15];

/**
 * Get the active tournament for a guild, or null.
 */
async function getActiveTournament(guildId) {
    return FishingTournament.findOne({ guildId, status: 'active' });
}

/**
 * Start a new tournament. durationMs defaults to 1 hour.
 */
async function startTournament(guildId, { durationMs = 60 * 60_000, seedAmount = 0, entryFee = 0, announceChannelId = null } = {}) {
    const existing = await FishingTournament.findOne({ guildId, status: { $in: ['scheduled', 'active'] } });
    if (existing) throw new Error('A tournament is already running or scheduled.');

    const now = new Date();
    return FishingTournament.create({
        guildId,
        status: 'active',
        startedAt: now,
        endsAt: new Date(now.getTime() + durationMs),
        prizePool: seedAmount,
        seedAmount,
        entryFee,
        announceChannelId
    });
}

/**
 * Submit a catch to the active tournament.
 * Returns the updated tournament doc, or null if no active tournament.
 * Only keeps the user's best catch (highest score).
 */
async function submitCatch(guildId, { userId, username, fishName, fishEmoji, tier, score, isBossKill = false }) {
    const tournament = await FishingTournament.findOne({ guildId, status: 'active' });
    if (!tournament) return null;

    // Check if tournament has expired
    if (new Date() > tournament.endsAt) {
        await endTournament(tournament._id);
        return null;
    }

    const existing = tournament.entries.find(e => e.userId === userId);
    if (existing) {
        if (score > existing.score) {
            existing.fishName  = fishName;
            existing.fishEmoji = fishEmoji;
            existing.tier      = tier;
            existing.score     = score;
            existing.caughtAt  = new Date();
            existing.isBossKill = isBossKill;
        }
    } else {
        if (tournament.entryFee > 0) {
            tournament.prizePool += tournament.entryFee;
        }
        tournament.entries.push({ userId, username, fishName, fishEmoji, tier, score, caughtAt: new Date(), isBossKill });
    }
    await tournament.save();
    return tournament;
}

/**
 * Get sorted leaderboard entries (best score first, tie-break by earliest caughtAt).
 */
function getSortedEntries(tournament) {
    return [...tournament.entries].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.caughtAt - b.caughtAt;
    });
}

/**
 * End a tournament, calculate prizes, return winner data.
 */
async function endTournament(tournamentId) {
    const tournament = await FishingTournament.findById(tournamentId);
    if (!tournament || tournament.status === 'ended') return tournament;

    tournament.status = 'ended';
    tournament.winnersAnnouncedAt = new Date();

    const sorted = getSortedEntries(tournament);
    const pool   = tournament.prizePool;

    tournament.prizes = [];
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const pct    = PRIZE_SPLITS[i];
        const amount = Math.round(pool * pct);
        if (amount > 0) {
            tournament.prizes.push({ place: i + 1, userId: sorted[i].userId, amount, paidOut: false });
        }
    }

    await tournament.save();
    return tournament;
}

/**
 * Build the live leaderboard embed.
 */
function buildLeaderboardEmbed(tournament, client) {
    const sorted   = getSortedEntries(tournament);
    const now      = new Date();
    const msLeft   = Math.max(0, tournament.endsAt - now);
    const minsLeft = Math.floor(msLeft / 60_000);
    const secsLeft = Math.floor((msLeft % 60_000) / 1000);
    const timeStr  = msLeft <= 0 ? 'Ended' : minsLeft > 0 ? `${minsLeft}m ${secsLeft}s remaining` : `${secsLeft}s remaining`;

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = sorted.slice(0, 10).map((e, i) => {
        const medal = medals[i] ?? `**${i + 1}.**`;
        const boss  = e.isBossKill ? ' 🐉' : '';
        return `${medal} <@${e.userId}> — ${e.fishEmoji} ${e.fishName} (${e.score.toLocaleString()} pts)${boss}`;
    });

    const desc = lines.length
        ? lines.join('\n') + (sorted.length > 10 ? `\n…and ${sorted.length - 10} more participants` : '')
        : '*No catches yet — be the first!*';

    const embed = new EmbedBuilder()
        .setColor('#1e90ff')
        .setTitle(`🎣 FISHING TOURNAMENT — ${timeStr}`)
        .setDescription(desc)
        .setTimestamp();

    if (tournament.prizePool > 0) {
        embed.addFields({ name: '💰 Prize Pool', value: tournament.prizePool.toLocaleString(), inline: true });
    }

    return embed;
}

/**
 * Build the tournament ended / winners embed.
 */
function buildWinnersEmbed(tournament, currency = '💰') {
    const sorted  = getSortedEntries(tournament);
    const medals  = ['🥇', '🥈', '🥉'];
    const lines   = sorted.slice(0, 3).map((e, i) => {
        const prize = tournament.prizes.find(p => p.place === i + 1);
        const pStr  = prize ? ` — wins **${currency}${prize.amount.toLocaleString()}**` : '';
        return `${medals[i]} <@${e.userId}> — ${e.fishEmoji} ${e.fishName} (${e.score.toLocaleString()} pts)${pStr}`;
    });

    return new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🏆 Fishing Tournament Results!')
        .setDescription(lines.length ? lines.join('\n') : '*No participants.*')
        .setTimestamp();
}

module.exports = {
    getActiveTournament,
    startTournament,
    submitCatch,
    getSortedEntries,
    endTournament,
    buildLeaderboardEmbed,
    buildWinnersEmbed
};
