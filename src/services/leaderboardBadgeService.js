/**
 * The weekly 👑 #1 leaderboard badges (#931).
 *
 * `/leaderboard` decides who is top of each category at any moment; this is
 * what turns being top on Sunday night into something visible on `/rank` for
 * the following week. Registered as a job in `services/scheduler/index.js`,
 * which owns the cron expression and runs it through `runJob`. Nothing here
 * schedules itself (#611).
 *
 * Wealth ranks through `utils/netWorth`, the same as every other wealth
 * surface — this file is one of the entries tests/netWorth.test.js holds to
 * that.
 *
 * @module services/leaderboardBadgeService
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { handlesGuild } = require('../utils/sharding');
const { topByNetWorth } = require('../utils/netWorth');
const { postAnnouncement } = require('../utils/guildAnnounce');
const COLORS = require('../utils/embedColors');

const LEADERBOARD_BADGE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Award the 7-day 👑 #1 badge to the top member in each leaderboard category,
 * in every guild. Weekly.
 *
 * Takes a short lease per guild (`badgesAwardLeaseAt`) so a second runner
 * cannot double-award the same week.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function awardWeeklyLeaderboardBadges(client) {
    const { EmbedBuilder } = require('discord.js');

    const guilds = await Guild.find({}, 'guildId name economy').lean();
    const weekAgo = new Date(Date.now() - LEADERBOARD_BADGE_DURATION_MS);

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        // Per-guild job. Before the lease, not after: a shard that cannot reach
        // this guild would otherwise take the week's lease and then have nowhere
        // to announce, leaving the shard that could with nothing to claim.
        if (!handlesGuild(guildId, client)) continue;

        try {
            // Atomically acquire a short-lived lease; badgesLastAwardedAt is only written on success
            const leaseUntil = new Date(Date.now() + 5 * 60 * 1000); // 5-minute lease window
            const leased = await Guild.findOneAndUpdate(
                {
                    guildId,
                    // Both conditions, under $and. They were two `$or` keys in
                    // one object literal, so the second silently replaced the
                    // first and only the lease was ever checked: the weekly
                    // cadence was not enforced at all, and badges could be
                    // re-awarded as soon as a five-minute lease lapsed.
                    $and: [
                        { $or: [{ badgesLastAwardedAt: null }, { badgesLastAwardedAt: { $lte: weekAgo } }] },
                        { $or: [{ badgesAwardLeaseAt: null }, { badgesAwardLeaseAt: { $lte: new Date() } }] },
                    ],
                },
                { $set: { badgesAwardLeaseAt: leaseUntil } },
                { new: false }
            );
            if (!leased) continue;

            const categories = [
                { key: 'levels',       sort: { level: -1, xp: -1 },            label: '📈 Top Level' },
                // Wealth ranks on balance + bank, same as every other wealth surface —
                // sorting on `balance` alone crowned whoever kept the most cash out
                // of the bank rather than whoever actually had the most. `netWorth`
                // routes this one through the shared aggregation instead of `sort`.
                { key: 'economy',      netWorth: true,                          label: '💰 Wealthiest' },
                { key: 'streaks',      sort: { 'streak.current': -1 },          label: '🔥 Longest Streak' },
                { key: 'duels',        sort: { duelWins: -1 },                  label: '⚔️ Duel Champion' },
                { key: 'achievements', sort: { achievementsCount: -1 },         label: '🏅 Achievement Hunter' },
            ];

            const badgeExpiry = new Date(Date.now() + LEADERBOARD_BADGE_DURATION_MS);
            const champLines = [];
            const discordGuild = await client.guilds.fetch(guildId).catch(() => null);

            for (const cat of categories) {
                const top = cat.netWorth
                    ? (await topByNetWorth(User, guildId, 1))[0]
                    : await User.findOne({ guildId }).sort(cat.sort).select('userId').lean();
                if (!top) continue;

                // Award badge (deduplicate: remove existing #1 badge for this category first)
                await User.updateOne(
                    { userId: top.userId, guildId },
                    {
                        $pull:  { badges: { id: `leaderboard_1_${cat.key}` } },
                    }
                ).catch(err => console.error(`[scheduler] badge $pull failed for ${top.userId}:`, err.message));
                await User.updateOne(
                    { userId: top.userId, guildId },
                    {
                        $push: { badges: { id: `leaderboard_1_${cat.key}`, label: '👑 #1', expiresAt: badgeExpiry } }
                    }
                ).catch(err => console.error(`[scheduler] badge $push failed for ${top.userId}:`, err.message));

                let username = `<@${top.userId}>`;
                if (discordGuild) {
                    const member = await discordGuild.members.fetch(top.userId).catch(() => null);
                    if (member) username = `<@${top.userId}> (${member.user.username})`;
                }
                champLines.push(`${cat.label}: ${username}`);
            }

            if (!champLines.length) {
                await Guild.updateOne({ guildId }, { $set: { badgesLastAwardedAt: new Date(), badgesAwardLeaseAt: null } });
                continue;
            }

            // Find announcement channel: economy.announcementChannelId or systemChannel
            let announceChannelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!announceChannelId && discordGuild) {
                announceChannelId = discordGuild.systemChannelId ?? null;
            }
            if (!announceChannelId) {
                await Guild.updateOne({ guildId }, { $set: { badgesLastAwardedAt: new Date(), badgesAwardLeaseAt: null } });
                continue;
            }

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('👑 Last Week\'s Champions')
                .setDescription(
                    'These legends dominated the leaderboards this week.\n' +
                    'Each earns a **👑 #1** badge for 7 days, visible on `/rank` and `/leaderboard`.'
                )
                .addFields({ name: '🏆 Winners', value: champLines.join('\n') })
                .setTimestamp();

            await postAnnouncement(client, guildId, announceChannelId, embed);
            // All work succeeded — commit the run timestamp and release lease
            await Guild.updateOne({ guildId }, { $set: { badgesLastAwardedAt: new Date(), badgesAwardLeaseAt: null } });
        } catch (err) {
            console.error(`[scheduler] weeklyLeaderboardBadges failed for guild ${guildId}:`, err.message);
            // Release lease so this guild is eligible for retry on the next cron tick
            await Guild.updateOne({ guildId }, { $set: { badgesAwardLeaseAt: null } }).catch(() => {});
        }
    }
}

module.exports = { awardWeeklyLeaderboardBadges };
