/**
 * Economy seasons: closing out one whose window has passed, and the sweep that
 * finds them (#931).
 *
 * The season here is the coin race — `Guild.currentSeason`, `User.seasonCoins`
 * and the frozen `SeasonRecord` leaderboard `/season records` reads back. It is
 * a different thing from `seasonMissionService` (the battle pass's daily
 * missions) and from `seasonalEventService` (the calendar events), which is why
 * this carries the `economy` prefix rather than taking the bare name.
 *
 * The sweep is registered as a job in `services/scheduler/index.js`, which owns
 * the cron expression and runs it through `runJob`. Nothing here schedules
 * itself (#611).
 *
 * - **Idempotent.** The resolution is claimed by clearing `currentSeason.id` in
 *   a single atomic update, and the leaderboard freeze rides on the unique
 *   index over (guildId, seasonId), so a second sweep finds nothing to do.
 * - **Per-guild failure isolation.** One guild's error is logged and the loop
 *   moves on.
 * - **Announcements and recap DMs are best-effort.** Neither rolls back a reset
 *   that has already landed.
 *
 * @module services/economySeasonService
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const SeasonRecord = require('../models/SeasonRecord');
const { handlesGuild } = require('../utils/sharding');
const { createSeasonRecapCard } = require('../utils/cardGenerator');
const { postAnnouncement } = require('../utils/guildAnnounce');
const { eventCommentary, addCommentary } = require('./commentaryService');
const COLORS = require('../utils/embedColors');

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

    // Single guild fetch shared by name resolution, recap DMs, and announcement
    let seasonDiscordGuild = null;
    let announceChannelId  = null;
    try {
        seasonDiscordGuild = await client.guilds.fetch(guildId).catch(() => null);
        announceChannelId  = guildDoc.economy?.announcementChannelId
            ?? seasonDiscordGuild?.systemChannelId
            ?? null;
    } catch {}

    const resolvedNames = {};
    if (seasonDiscordGuild) {
        for (const u of topUsers.slice(0, 3)) {
            const member = await seasonDiscordGuild.members.fetch(u.userId).catch(() => null);
            resolvedNames[u.userId] = member?.user?.username ?? 'Unknown';
        }
    }

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

    // Gather active participants for recap before resetting their coins
    const activePlayers = await User.find(
        { guildId, 'season.seasonId': season.id, 'season.xp': { $gt: 0 } },
        'userId season duelWins duelLosses questsCompleted hunt fishing mining'
    ).lean();

    // Build a rank map by seasonCoins for the recap cards
    const allRanked = await User.find(
        { guildId, 'season.seasonId': season.id },
        'userId seasonCoins'
    ).sort({ seasonCoins: -1 }).lean();
    const rankMap          = new Map(allRanked.map((u, i) => [u.userId, i + 1]));
    const totalParticipants = allRanked.length;

    // Reset seasonCoins for everyone in the guild
    await User.updateMany({ guildId }, { $set: { seasonCoins: 0 } })
        .catch(err => console.error('[scheduler] seasonCoins reset failed:', err.message));

    // DM each active player a personalised recap card (fire-and-forget)
    if (activePlayers.length > 0 && seasonDiscordGuild) {
        const { AttachmentBuilder } = require('discord.js');
        const capturedChannelId = announceChannelId;
        (async () => {
            for (const u of activePlayers) {
                try {
                    const member = await seasonDiscordGuild.members.fetch(u.userId).catch(() => null);
                    if (!member) continue;

                    const rank = rankMap.get(u.userId) ?? null;
                    const buf  = await createSeasonRecapCard(u, season.name ?? season.id, rank, totalParticipants);
                    const file = new AttachmentBuilder(buf, {
                        name: 'season_recap.png',
                        description: `${season.name ?? season.id} recap card for ${member.user.username}`
                            + (rank ? `, finishing ${rank} of ${totalParticipants}.` : '.'),
                    });

                    await member.send({
                        content: `🏁 **Your ${season.name ?? season.id} recap is here!** Screenshot and share it — see you next season!`,
                        files:   [file],
                    }).catch(() => {});
                } catch { /* non-critical per-user failure */ }
            }

            if (capturedChannelId) {
                await postAnnouncement(client, guildId, capturedChannelId,
                    `📸 **Season ended!** Check your DMs for your personalised recap card. Share it here and show off your season!`
                );
            }
        })().catch(err => console.error('[scheduler] season recap DMs failed:', err.message));
    }

    const { EmbedBuilder } = require('discord.js');
    const currency = guildDoc.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const winnerLines = topUsers.slice(0, 3).map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`🏁 Season Ended: ${season.name ?? season.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    // The season's own sign-off, in the guild's voice (#836). The podium is
    // named rather than mentioned: the commentary is prose, and a model handed
    // `<@123>` writes it back into a sentence where it reads as noise.
    const podium = topUsers.slice(0, 3).map((u, i) =>
        `${i + 1}. ${resolvedNames[u.userId] ?? 'Unknown'} — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    );
    addCommentary(embed, await eventCommentary(guildDoc, {
        event: 'season',
        facts: {
            season: season.name ?? season.id,
            'final podium': podium.length ? podium.join('; ') : 'nobody scored',
            'players who took part': totalParticipants,
            'winner\'s margin over second': topUsers.length > 1
                ? ((topUsers[0].seasonCoins ?? 0) - (topUsers[1].seasonCoins ?? 0)).toLocaleString()
                : null
        }
    }).catch(() => null));

    await postAnnouncement(client, guildId, announceChannelId, embed);
    return true;
}

/**
 * Close out every expired economy season: freeze the leaderboard, pay the top
 * three, reset season coins, and post the recap.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function resolveExpiredSeasons(client) {
    const expired = await Guild.find({
        'currentSeason.id': { $ne: null },
        'currentSeason.endsAt': { $ne: null, $lte: new Date() }
    });

    for (const guildDoc of expired) {
        // Per-guild job: each shard resolves only its own guilds' seasons.
        if (!handlesGuild(guildDoc.guildId, client)) continue;

        try {
            await resolveOneSeason(client, guildDoc);
        } catch (err) {
            console.error(`[scheduler] resolveOneSeason failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

module.exports = { resolveExpiredSeasons };
