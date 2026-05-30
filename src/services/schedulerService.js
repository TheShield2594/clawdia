const Guild = require('../models/Guild');
const User = require('../models/User');
const SeasonRecord = require('../models/SeasonRecord');

const WAR_BOOSTER_DURATION_MS = 24 * 60 * 60 * 1000;

async function postAnnouncement(client, guildId, channelId, embed) {
    if (!channelId) return;
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;
        await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        console.error(`[scheduler] announcement post failed for guild ${guildId}:`, err.message);
    }
}

// Resolves a single expired war atomically. Returns true if this call performed
// the resolution (idempotent — concurrent invocations will only resolve once).
async function resolveOneWar(client, guildDoc) {
    const guildId = guildDoc.guildId;
    const war = guildDoc.activeWar;

    // Atomically flip status='active' → 'ended' so duplicate sweeps no-op
    const claimed = await Guild.findOneAndUpdate(
        { guildId, 'activeWar.status': 'active' },
        { $set: { 'activeWar.status': 'ended' } },
        { new: false }
    );
    if (!claimed) return false;

    const myScore = war.myScore ?? 0;
    const oppScore = war.opponentScore ?? 0;
    const tied = myScore === oppScore;
    const iWon = myScore > oppScore;

    // End the opponent's mirrored war record too
    if (war.opponentGuildId) {
        await Guild.findOneAndUpdate(
            { guildId: war.opponentGuildId, 'activeWar.opponentGuildId': guildId, 'activeWar.status': 'active' },
            { $set: { 'activeWar.status': 'ended' } }
        ).catch(err => console.error(`[scheduler] opponent war end failed:`, err.message));
    }

    // Reward winners with a 24h 2x coin booster
    if (iWon) {
        const expiresAt = new Date(Date.now() + WAR_BOOSTER_DURATION_MS);
        await User.updateMany(
            { guildId },
            { $push: { activeEffects: { type: 'coin_booster_2x', expiresAt, charges: -1 } } }
        ).catch(err => console.error(`[scheduler] war booster grant failed:`, err.message));
    }

    const { EmbedBuilder } = require('discord.js');
    const oppName = war.opponentGuildName ?? 'Enemy Server';
    const title = tied ? '⚔️ War Ended — Tie!' : iWon ? '🏆 War Victory!' : '⚔️ War Lost';
    const desc = tied
        ? `The war against **${oppName}** ended in a tie at **${myScore.toLocaleString()}** points each.`
        : iWon
            ? `**${guildDoc.name}** has defeated **${oppName}**!\n\n` +
              `Final score: **${myScore.toLocaleString()}** vs **${oppScore.toLocaleString()}**\n\n` +
              `All members receive a **2x coin booster** for the next 24 hours!`
            : `**${oppName}** has defeated us.\n\nFinal score: **${myScore.toLocaleString()}** vs **${oppScore.toLocaleString()}**`;

    const embed = new EmbedBuilder()
        .setColor(tied ? '#95a5a6' : iWon ? '#FFD700' : '#e74c3c')
        .setTitle(title)
        .setDescription(desc)
        .setTimestamp();

    await postAnnouncement(client, guildId, war.announcementChannelId, embed);
    return true;
}

async function resolveExpiredWars(client) {
    const expired = await Guild.find({
        'activeWar.status': 'active',
        'activeWar.endsAt': { $ne: null, $lte: new Date() }
    });

    for (const guildDoc of expired) {
        try {
            await resolveOneWar(client, guildDoc);
        } catch (err) {
            console.error(`[scheduler] resolveOneWar failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

async function resolveOneSeason(client, guildDoc) {
    const guildId = guildDoc.guildId;
    const season = guildDoc.currentSeason;
    if (!season?.id) return false;

    // Atomically claim this season by clearing currentSeason.id. Duplicate sweeps no-op.
    const claimed = await Guild.findOneAndUpdate(
        { guildId, 'currentSeason.id': season.id },
        { $set: { currentSeason: { id: null, name: null, startedAt: null, endsAt: null } } },
        { new: false }
    );
    if (!claimed) return false;

    const topUsers = await User.find({ guildId })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins')
        .lean();

    let resolvedNames = {};
    try {
        const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
            for (const u of topUsers.slice(0, 3)) {
                const member = await discordGuild.members.fetch(u.userId).catch(() => null);
                resolvedNames[u.userId] = member?.user?.username ?? 'Unknown';
            }
        }
    } catch {}

    // Freeze the leaderboard. Unique index on (guildId, seasonId) makes this idempotent.
    try {
        await SeasonRecord.create({
            guildId,
            seasonId: season.id,
            seasonName: season.name,
            startedAt: season.startedAt,
            endedAt: new Date(),
            top10: topUsers.map(u => ({
                userId: u.userId,
                username: resolvedNames[u.userId] ?? 'Unknown',
                coins: u.seasonCoins ?? 0
            }))
        });
    } catch (err) {
        // duplicate key means another worker already froze this season
        if (err.code !== 11000) throw err;
    }

    // Reset seasonCoins for everyone in the guild
    await User.updateMany({ guildId }, { $set: { seasonCoins: 0 } })
        .catch(err => console.error('[scheduler] seasonCoins reset failed:', err.message));

    const { EmbedBuilder } = require('discord.js');
    const currency = guildDoc.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const winnerLines = topUsers.slice(0, 3).map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle(`🏁 Season Ended: ${season.name ?? season.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    // Announcement channel: reuse the war channel only if set on the season; otherwise
    // fall back to the system channel of the guild.
    let announceChannelId = null;
    try {
        const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
        announceChannelId = discordGuild?.systemChannelId ?? null;
    } catch {}

    await postAnnouncement(client, guildId, announceChannelId, embed);
    return true;
}

async function resolveExpiredSeasons(client) {
    const expired = await Guild.find({
        'currentSeason.id': { $ne: null },
        'currentSeason.endsAt': { $ne: null, $lte: new Date() }
    });

    for (const guildDoc of expired) {
        try {
            await resolveOneSeason(client, guildDoc);
        } catch (err) {
            console.error(`[scheduler] resolveOneSeason failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

module.exports = { resolveExpiredWars, resolveExpiredSeasons };
