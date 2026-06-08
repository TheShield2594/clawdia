'use strict';

const FishingTournament = require('../models/FishingTournament');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');
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
    // Atomically claim the tournament; returns null if already ended or claimed by another caller
    const tournament = await FishingTournament.findOneAndUpdate(
        { _id: tournamentId, status: 'active' },
        { $set: { status: 'ended', winnersAnnouncedAt: new Date() } },
        { new: true }
    );
    if (!tournament) {
        // Already ended — return the existing doc for embed building
        return FishingTournament.findById(tournamentId);
    }

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

    // Pay out each winner; only mark paidOut when the credit succeeded
    for (const prize of tournament.prizes) {
        const updatedUser = await User.findOneAndUpdate(
            { userId: prize.userId, guildId: tournament.guildId },
            { $inc: { balance: prize.amount } },
            { new: true }
        );
        if (updatedUser) {
            prize.paidOut = true;
            logTransaction({
                userId:  prize.userId,
                guildId: tournament.guildId,
                type:    'tournament_prize',
                amount:  prize.amount,
                balance: updatedUser.balance,
                note:    `Tournament place #${prize.place}`,
            });
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

/**
 * Post a tournament start announcement to the configured channel.
 */
async function announceTournamentStart(client, tournament, guildId, announcementChannelId) {
    if (!announcementChannelId) return;
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const channel = await guild.channels.fetch(announcementChannelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;

        const minsLeft = Math.round((tournament.endsAt - new Date()) / 60_000);
        const embed = new EmbedBuilder()
            .setColor('#1e90ff')
            .setTitle('🎣 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            .setDescription(
                `**FISHING TOURNAMENT STARTING NOW!**\n` +
                `⏱️ Duration: **${minsLeft} minutes**\n` +
                (tournament.prizePool > 0 ? `🏆 Prize Pool: **${tournament.prizePool.toLocaleString()} coins**\n` : '') +
                `🎣 Rarest catch wins! Use \`/fish cast\` to compete!\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
            )
            .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        console.error('[tournament] start announcement failed:', err.message);
    }
}

/**
 * Post a tournament end announcement to the configured channel.
 */
async function announceTournamentEnd(client, tournament, guildId, announcementChannelId) {
    if (!announcementChannelId) return;
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const channel = await guild.channels.fetch(announcementChannelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;

        const winnersEmbed = buildWinnersEmbed(tournament);
        await channel.send({ embeds: [winnersEmbed] }).catch(() => {});
    } catch (err) {
        console.error('[tournament] end announcement failed:', err.message);
    }
}

module.exports = {
    getActiveTournament,
    startTournament,
    submitCatch,
    getSortedEntries,
    endTournament,
    buildLeaderboardEmbed,
    buildWinnersEmbed,
    announceTournamentStart,
    announceTournamentEnd,
};
