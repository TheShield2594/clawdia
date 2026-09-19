'use strict';

const FishingTournament = require('../models/FishingTournament');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');
const { creditCoinsOrOwe } = require('../utils/creditOrOwe');
const { tournamentPrizePayoutKey } = require('../utils/payoutKey');
const { EmbedBuilder } = require('discord.js');
const COLORS = require('../utils/embedColors');

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
    // Each share is rounded on its own, and three independent roundings can add
    // up to more than there is: a pool of 10 rounds to 6 + 3 + 2 = 11, and the
    // eleventh coin is minted out of nothing. Tracking what is left and capping
    // each share against it means the split can never pay out more than the
    // pool held, whatever the rounding does. A remainder left over by rounding
    // down stays unpaid, as the places that do not exist always have.
    let unallocated = pool;
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const pct    = PRIZE_SPLITS[i];
        const amount = Math.min(Math.round(pool * pct), unallocated);
        if (amount > 0) {
            unallocated -= amount;
            tournament.prizes.push({ place: i + 1, userId: sorted[i].userId, amount, paidOut: false });
        }
    }

    // Pay out each winner. The claim above makes this loop run once, but the
    // credit inside it was a bare `$inc` with nothing behind it (#873, pass 7):
    // a transient failure or a winner who had left the guild left `paidOut:
    // false` on the tournament with no owed record and no replay, while the
    // winners embed announced the prize regardless. The keyed helper records a
    // prize it cannot land as a replayable owed payout, and the key means a
    // replay — or a second `endTournament` that somehow got past the claim —
    // cannot pay it twice. `paidOut` is set only on a real credit; `owed` marks
    // the ones written down so the embed can say so rather than promising coins.
    for (const prize of tournament.prizes) {
        const paid = await creditCoinsOrOwe(
            { userId: prize.userId, guildId: tournament.guildId },
            prize.amount,
            {
                payoutKey: tournamentPrizePayoutKey(tournament._id, prize.place),
                service: 'tournamentService', jobName: 'tournamentPrize',
            }
        );
        if (paid.credited) {
            prize.paidOut = true;
            // A credit that landed on a retry after a lost response comes back
            // with no document, so read the settled balance for the ledger row
            // rather than reporting the pre-credit figure.
            const balance = paid.doc?.balance
                ?? (await User.findOne({ userId: prize.userId, guildId: tournament.guildId }, 'balance').lean())?.balance
                ?? prize.amount;
            logTransaction({
                userId:  prize.userId,
                guildId: tournament.guildId,
                type:    'tournament_prize',
                amount:  prize.amount,
                balance,
                note:    `Tournament place #${prize.place}`,
            });
        } else {
            prize.owed = paid.owed;
        }
    }

    await tournament.save();
    return tournament;
}

/**
 * Build the live leaderboard embed.
 */
function buildLeaderboardEmbed(tournament, _client) {
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
        // A prize that could not be credited is not announced as won: the payout
        // records it as owed and `payouts:replay` settles it, so the embed says
        // that rather than promising coins that are not in the wallet (#873).
        const pStr  = !prize
            ? ''
            : prize.paidOut === false
                ? ` — **${currency}${prize.amount.toLocaleString()}** owed (being settled)`
                : ` — wins **${currency}${prize.amount.toLocaleString()}**`;
        return `${medals[i]} <@${e.userId}> — ${e.fishEmoji} ${e.fishName} (${e.score.toLocaleString()} pts)${pStr}`;
    });

    return new EmbedBuilder()
        .setColor(COLORS.PRIZE)
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
