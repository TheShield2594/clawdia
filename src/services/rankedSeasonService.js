/**
 * Ranked duel seasons: initialising the first one, and rolling over the ones
 * that have ended (issue #339, split out in #931).
 *
 * `utils/duelElo.js` holds the rating arithmetic — the soft reset toward 1200,
 * the tier a rating falls in, the season id — and `/duel ranked` plays the
 * games. This is the rollover:
 *
 *  1. Awards top-3 prizes (coins + seasonal title)
 *  2. Soft-decays all ELO toward 1200
 *  3. Resets season counters and starts the next season
 *
 * Registered as a job in `services/scheduler/index.js`, which owns the cron
 * expression and runs it through `runJob`; nothing here schedules itself
 * (#611).
 *
 * @module services/rankedSeasonService
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const { softResetElo, tierFor, makeSeasonId } = require('../utils/duelElo');
const { postAnnouncement } = require('../utils/guildAnnounce');
const COLORS = require('../utils/embedColors');

/**
 * Roll over expired ranked-duel seasons: pay the top three and give them the
 * seasonal title, soft-decay every ELO toward 1200, reset the counters and
 * start the next season.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function resolveRankedSeasons(client) {
    const { EmbedBuilder } = require('discord.js');
    const now = new Date();
    // Initialize the first season for any guild that has ranked enabled but no season yet
    const uninitialized = await Guild.find({
        'rankedDuels.enabled': true,
        $or: [
            { 'rankedDuels.currentSeasonId': null },
            { 'rankedDuels.seasonEndsAt': null },
        ]
    });
    for (const g of uninitialized) {
        // Per-guild job: two shards initialising the same guild's first season
        // would race on a plain save, with no claim to settle it.
        if (!handlesGuild(g.guildId, client)) continue;

        const seasonNumber = g.rankedDuels.seasonNumber ?? 1;
        const days = g.rankedDuels.seasonDurationDays ?? 60;
        g.rankedDuels.currentSeasonId = makeSeasonId(seasonNumber);
        g.rankedDuels.seasonStartedAt = now;
        g.rankedDuels.seasonEndsAt    = new Date(now.getTime() + days * 86_400_000);
        await g.save().catch(err => console.error('[scheduler] ranked season init failed:', err.message));
    }

    const expired = await Guild.find({
        'rankedDuels.enabled': true,
        'rankedDuels.seasonEndsAt': { $ne: null, $lte: now },
    });

    for (const guildDoc of expired) {
        // Per-guild job, checked before the season-end claim below.
        if (!handlesGuild(guildDoc.guildId, client)) continue;

        try {
            const guildId  = guildDoc.guildId;
            const seasonId = guildDoc.rankedDuels.currentSeasonId;
            const seasonNumber = guildDoc.rankedDuels.seasonNumber ?? 1;
            const reward   = guildDoc.rankedDuels.topReward ?? 50_000;
            const currency = guildDoc.economy?.currency ?? '💰';

            // Atomically claim this season-end so concurrent sweeps no-op
            const days = guildDoc.rankedDuels.seasonDurationDays ?? 60;
            const newSeasonNumber = seasonNumber + 1;
            const claimed = await Guild.findOneAndUpdate(
                { guildId, 'rankedDuels.currentSeasonId': seasonId },
                {
                    $set: {
                        'rankedDuels.currentSeasonId': makeSeasonId(newSeasonNumber),
                        'rankedDuels.seasonNumber':    newSeasonNumber,
                        'rankedDuels.seasonStartedAt': now,
                        'rankedDuels.seasonEndsAt':    new Date(now.getTime() + days * 86_400_000),
                    }
                },
                { new: false }
            );
            if (!claimed) continue;

            // Only count users active *this* season so that prior-season
            // winners (whose seasonPeakElo lingers until the next soft-reset
            // ticks them) don't reclaim a top-3 slot without playing.
            const top = await User.find({
                guildId,
                $or: [
                    { 'ranked.seasonRankedWins':   { $gt: 0 } },
                    { 'ranked.seasonRankedLosses': { $gt: 0 } },
                ],
                'ranked.currentSeasonId': seasonId,
            })
                .sort({ 'ranked.seasonPeakElo': -1 })
                .limit(3)
                .select('userId ranked')
                .lean();

            const rewards = [reward, Math.floor(reward * 0.6), Math.floor(reward * 0.3)];
            const medals  = ['🥇', '🥈', '🥉'];

            for (let i = 0; i < top.length; i++) {
                const u = top[i];
                const titleLabel = `${seasonId} ${i === 0 ? 'Champion' : i === 1 ? 'Runner-Up' : 'Third Place'}`;
                const peakTier   = tierFor(u.ranked?.seasonPeakElo ?? 1000);
                await User.updateOne(
                    { userId: u.userId, guildId },
                    {
                        $inc: { balance: rewards[i] },
                        $addToSet: { 'ranked.seasonalTitles': titleLabel },
                        $set: {
                            'ranked.peakSeasonTitle': peakTier.label,
                            'ranked.lastSeasonId':   seasonId,
                        },
                    },
                ).catch(err => console.error('[scheduler] ranked reward update failed:', err.message));
            }

            // Soft-reset ELO toward 1200 for every participant
            const participants = await User.find({
                guildId,
                $or: [
                    { 'ranked.rankedWins': { $gt: 0 } },
                    { 'ranked.rankedLosses': { $gt: 0 } },
                ]
            }).select('_id ranked').lean();
            const bulk = participants.map(u => ({
                updateOne: {
                    filter: { _id: u._id },
                    update: {
                        $set: {
                            'ranked.elo':                softResetElo(u.ranked?.elo ?? 1000),
                            'ranked.seasonPeakElo':      softResetElo(u.ranked?.elo ?? 1000),
                            'ranked.seasonRankedWins':   0,
                            'ranked.seasonRankedLosses': 0,
                            'ranked.currentSeasonId':    makeSeasonId(newSeasonNumber),
                        }
                    }
                }
            }));
            if (bulk.length) {
                await User.bulkWrite(bulk, { ordered: false })
                    .catch(err => console.error('[scheduler] ranked soft reset failed:', err.message));
            }

            const channelId = guildDoc.rankedDuels.announceChannelId
                ?? guildDoc.economy?.announcementChannelId
                ?? null;
            if (channelId) {
                const lines = top.length
                    ? top.map((u, i) => `${medals[i]} <@${u.userId}> — ${u.ranked?.seasonPeakElo ?? 1000} ELO · earned **${currency}${rewards[i].toLocaleString()}** + title *"${seasonId} ${i === 0 ? 'Champion' : i === 1 ? 'Runner-Up' : 'Third Place'}"*`).join('\n')
                    : '_No ranked games played this season._';
                const embed = new EmbedBuilder()
                    .setColor(COLORS.RARE)
                    .setTitle(`🏆 Ranked Season Ended — ${seasonId}`)
                    .setDescription(lines)
                    .setFooter({ text: `Season ${newSeasonNumber} starts now — ELO soft-reset toward 1200.` })
                    .setTimestamp();
                await postAnnouncement(client, guildId, channelId, embed);
            }
        } catch (err) {
            console.error(`[scheduler] resolveRankedSeasons failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

module.exports = { resolveRankedSeasons };
