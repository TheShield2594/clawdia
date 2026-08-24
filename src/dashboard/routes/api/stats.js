const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const GuildAnalytics = require('../../../models/GuildAnalytics');
const User = require('../../../models/User');
const Case = require('../../../models/Case');
const { checkAuth, checkGuildAccess } = require('../../lib/middleware');
const { computeRetention, median, parseChannelIdFromJumpUrl } = require('../../lib/apiHelpers');
const { cachedAggregate } = require('../../lib/aggregateCache');

// Telemetry lives in its own GuildAnalytics collection; the Guild document is
// read only for the handful of settings the recommendations look at, named so
// the shop's image Buffers never enter the response path.
const STATS_GUILD_FIELDS = 'welcome moderation leveling economy rssFeeds';

// Moderation cases are read for four aggregates over five fields. Hydrating a
// thousand full case documents to compute them is the expensive half of this
// route.
const CASE_FIELDS = 'type createdAt resolvedAt evidence.jumpUrl';

// The whole payload is memoised, not just the queries inside it. Every panel on
// the dashboard's overview asks for this route on load, a left-open tab asks for
// it again on every refresh, and the answer is a summary of the last thirty days
// — it does not become wrong in a minute. The per-query memos below stay because
// they are shared with /economy/stats, which asks two of the same questions.
const STATS_RESPONSE_TTL_MS = 60_000;

async function buildGuildStats(guildId) {
    // Every one of these touches the guild's whole user collection, and the page
    // that calls this route also calls /economy/stats, which asks two of the same
    // questions. Memoised so that costs one scan, not five.
    const [totalUsers, totalMessages, topLevels, guildSettings, analytics] = await Promise.all([
        cachedAggregate(`${guildId}:stats:users`, () => User.countDocuments({ guildId })),
        cachedAggregate(`${guildId}:stats:messages`, () => User.aggregate([
            { $match: { guildId } },
            { $group: { _id: null, total: { $sum: '$messages' } } }
        ])),
        cachedAggregate(`${guildId}:stats:topLevels`, () => User.find({ guildId })
            .select('userId level xp')
            .sort({ level: -1, xp: -1 })
            .limit(10)
            .lean()),
        Guild.findOne({ guildId }).select(STATS_GUILD_FIELDS).lean(),
        GuildAnalytics.findOne({ guildId }).lean()
    ]);
    const memberEvents = analytics?.memberEvents || [];
    const commandUsage = analytics?.commandUsage || [];

    const { joins30, leaves30, retained7, retained30 } = computeRetention(memberEvents);

    // `commandUsage` is a capped log of the guild's recent command traffic — on a
    // busy server, thousands of entries. It used to be walked twice, once for the
    // per-command summary and again for the daily volume series, and the busiest
    // hour per channel was then found by sorting each channel's hour histogram.
    // All of it is derivable in a single pass, keeping running maxima instead of
    // sorting: one traversal, and no per-channel sort.
    const commandSummary = {};
    const failedByReason = {};
    const bestTimesByChannel = new Map();
    const msgVolMap = {};
    for (const item of commandUsage) {
        commandSummary[item.command] = commandSummary[item.command] || { total: 0, failed: 0 };
        commandSummary[item.command].total += 1;
        if (!item.success) {
            commandSummary[item.command].failed += 1;
            failedByReason[item.reason || 'unknown'] = (failedByReason[item.reason || 'unknown'] || 0) + 1;
        }

        const channelId = item.channelId || 'unknown';
        let channel = bestTimesByChannel.get(channelId);
        if (!channel) {
            channel = { hours: {}, bestHour: 0, bestCount: 0 };
            bestTimesByChannel.set(channelId, channel);
        }
        const count = (channel.hours[item.hour] || 0) + 1;
        channel.hours[item.hour] = count;
        // The sort this replaces ran over `Object.entries(hours)`, whose keys are
        // small integers and so come back in ascending numeric order; a stable
        // sort therefore broke ties toward the earlier hour. The running maximum
        // breaks them the same way rather than toward whichever hour got there
        // first.
        if (count > channel.bestCount || (count === channel.bestCount && item.hour < channel.bestHour)) {
            channel.bestCount = count;
            channel.bestHour = item.hour;
        }

        if (item.createdAt) {
            const day = new Date(item.createdAt).toISOString().slice(0, 10);
            msgVolMap[day] = (msgVolMap[day] || 0) + 1;
        }
    }
    const bestPostingTimes = [...bestTimesByChannel.entries()]
        .slice(0, 8)
        .map(([channelId, channel]) => ({ channelId, hourUtc: Number(channel.bestHour) || 0 }));

    const recommendations = [];
    if (leaves30 > joins30 * 0.6 && !guildSettings?.welcome?.dmEnabled) recommendations.push('Enable welcome DMs to improve first-week retention.');
    if (!guildSettings?.moderation?.enabled || !guildSettings?.moderation?.autoModEnabled) recommendations.push('Enable auto-moderation, your raid/spam risk is elevated.');
    if ((failedByReason.execution_error || 0) > 10) recommendations.push('High command error volume detected. Audit recent command updates.');
    if ((guildSettings?.rssFeeds?.length || 0) === 0) recommendations.push('Add RSS or Daily News automation to keep channels active.');

    // Member growth: derive from memberEvents (last 30 days). Indexed by date
    // first, so the thirty lookups below are thirty map hits rather than thirty
    // linear scans of the event log.
    const eventsByDate = new Map(memberEvents.map(event => [event.date, event]));
    const now30 = Date.now();
    const memberGrowth = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(now30 - i * 864e5).toISOString().slice(0, 10);
        const ev = eventsByDate.get(d);
        memberGrowth.push({ date: d, joins: ev?.joins || 0, leaves: ev?.leaves || 0 });
    }

    // Message volume proxy: commandUsage events grouped by day (last 30 days),
    // tallied in the single pass above.
    const messageVolume = memberGrowth.map(({ date }) => ({ date, count: msgVolMap[date] || 0 }));

    // Economy stats summary
    const [ecoTotalAgg, ecoActiveCount] = await Promise.all([
        cachedAggregate(`${guildId}:stats:ecoTotal`, () => User.aggregate([
            { $match: { guildId } },
            { $group: { _id: null, total: { $sum: { $add: ['$balance', '$bank'] } }, avgXp: { $avg: '$xp' } } }
        ])),
        // Same question, same key as /economy/stats asks it under.
        cachedAggregate(`${guildId}:economy:active`, () => User.countDocuments({ guildId, $or: [
            { lastWork:  { $gte: new Date(Date.now() - 7 * 864e5) } },
            { lastDaily: { $gte: new Date(Date.now() - 7 * 864e5) } },
            { lastFish:  { $gte: new Date(Date.now() - 7 * 864e5) } },
            { lastMine:  { $gte: new Date(Date.now() - 7 * 864e5) } },
            { lastCrime: { $gte: new Date(Date.now() - 7 * 864e5) } },
            { lastHeist: { $gte: new Date(Date.now() - 7 * 864e5) } },
            { lastRob:   { $gte: new Date(Date.now() - 7 * 864e5) } }
        ] }))
    ]);

    return {
        totalUsers,
        totalMessages: totalMessages[0]?.total || 0,
        topLevels: topLevels.map(u => ({
            userId: u.userId,
            level: u.level,
            xp: u.xp
        })),
        analytics: {
            growthFunnel: { joins30, retained7: Number((retained7 * 100).toFixed(1)), retained30: Number((retained30 * 100).toFixed(1)) },
            churnAlerts: leaves30 > joins30 * 0.5 ? ['Churn is elevated over the last 30 days.'] : [],
            likelyCauses: [
                !guildSettings?.welcome?.enabled ? 'Welcome flow is disabled.' : null,
                !guildSettings?.leveling?.enabled ? 'No progression loop (leveling disabled).' : null,
                !guildSettings?.economy?.enabled ? 'No recurring incentive loop (economy disabled).' : null
            ].filter(Boolean),
            bestPostingTimes,
            commandUsage: commandSummary,
            failedCommands: failedByReason,
            recommendations,
            messageVolume,
            memberGrowth,
            economyStats: {
                totalCoins: ecoTotalAgg[0]?.total || 0,
                activeUsers: ecoActiveCount
            },
            xpStats: {
                avgXp: ecoTotalAgg[0]?.avgXp ? Math.round(ecoTotalAgg[0].avgXp) : 0
            }
        }
    };
}

// The dashboard's headline numbers for a guild: members, messages, economy and leveling totals.
router.get('/guild/:guildId/stats', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        res.json(await cachedAggregate(
            `${guildId}:stats:response`,
            () => buildGuildStats(guildId),
            STATS_RESPONSE_TTL_MS
        ));
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Derived analytics: 7 and 30 day retention, activity by hour, and command usage.
router.get('/guild/:guildId/insights', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const [guildExists, analytics] = await Promise.all([
            Guild.exists({ guildId }),
            GuildAnalytics.findOne({ guildId }).lean()
        ]);
        if (!guildExists) return res.status(404).json({ error: 'Guild not found' });

        const memberEvents = analytics?.memberEvents || [];
        const commandUsage = analytics?.commandUsage || [];

        // Retention: 7/30 day net-retention proxy from join/leave tracking.
        const { joins7, leaves7, joins30, leaves30, retained7, retained30 } = computeRetention(memberEvents);

        // Active hours: command-driven activity histogram (UTC).
        const hourMap = Array.from({ length: 24 }, (_, hour) => ({ hourUtc: hour, count: 0 }));
        for (const event of commandUsage) {
            if (typeof event.hour === 'number' && event.hour >= 0 && event.hour <= 23) {
                hourMap[event.hour].count += 1;
            }
        }
        const topActiveHours = [...hourMap].sort((a, b) => b.count - a.count).slice(0, 5);

        // Toxic channel hotspot proxy from moderation case evidence jump URLs.
        const recentCases = await Case.find({ guildId }).select(CASE_FIELDS).sort({ createdAt: -1 }).limit(1000).lean();
        const channelToxicity = new Map();
        for (const c of recentCases) {
            const channelId = parseChannelIdFromJumpUrl(c?.evidence?.jumpUrl) || 'unknown';
            const current = channelToxicity.get(channelId) || { channelId, incidents: 0, warns: 0, severe: 0, score: 0 };
            current.incidents += 1;
            if (c.type === 'warn') current.warns += 1;
            if (['mute', 'kick', 'ban'].includes(c.type)) current.severe += 1;
            current.score = current.warns + (current.severe * 2);
            channelToxicity.set(channelId, current);
        }
        const toxicChannels = [...channelToxicity.values()].sort((a, b) => b.score - a.score).slice(0, 8);

        // Moderator SLA: median time to close case + trend grouped by month.
        const resolvedCases = recentCases.filter(c => c.createdAt && c.resolvedAt);
        const resolutionHours = resolvedCases.map(c => (new Date(c.resolvedAt) - new Date(c.createdAt)) / 36e5).filter(h => h >= 0);
        const medianResolutionHours = median(resolutionHours);

        const monthlyTrend = {};
        for (const c of resolvedCases) {
            const dt = new Date(c.resolvedAt);
            const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
            if (!monthlyTrend[key]) monthlyTrend[key] = [];
            monthlyTrend[key].push((new Date(c.resolvedAt) - new Date(c.createdAt)) / 36e5);
        }
        const modSlaTrends = Object.entries(monthlyTrend)
            .map(([month, arr]) => ({ month, medianResolutionHours: Number((median(arr) || 0).toFixed(2)), resolvedCases: arr.length }))
            .sort((a, b) => a.month.localeCompare(b.month))
            .slice(-6);

        // Newcomer conversion after 7/30 days based on user activity.
        //
        // Counted in the pipeline rather than by pulling every user in the guild into
        // the process and filtering the array four times. The old shape was the one
        // unbounded read on this route: four counts, and the peak memory to produce
        // them grew with the size of the server.
        //
        // The 30-day cohort is a subset of the 7-day one, so a single `$match` on the
        // wider window feeds both; `$match` on `createdAt` also drops the documents
        // the array filters were rejecting for having no `createdAt` at all.
        const [cohorts] = await cachedAggregate(`${guildId}:insights:cohorts`, () => User.aggregate([
            { $match: { guildId, createdAt: { $lte: new Date(Date.now() - 7 * 864e5) } } },
            { $set: {
                inCohort30: { $lte: ['$createdAt', new Date(Date.now() - 30 * 864e5)] },
                converted: { $or: [
                    { $gte: [{ $ifNull: ['$messages', 0] }, 20] },
                    { $gte: [{ $ifNull: ['$level', 0] }, 2] }
                ] }
            } },
            { $group: {
                _id: null,
                cohort7:     { $sum: 1 },
                converted7:  { $sum: { $cond: ['$converted', 1, 0] } },
                cohort30:    { $sum: { $cond: ['$inCohort30', 1, 0] } },
                converted30: { $sum: { $cond: [{ $and: ['$inCohort30', '$converted'] }, 1, 0] } }
            } }
        ]));

        const cohort7Size  = cohorts?.cohort7 ?? 0;
        const cohort30Size = cohorts?.cohort30 ?? 0;
        const converted7   = cohorts?.converted7 ?? 0;
        const converted30  = cohorts?.converted30 ?? 0;

        res.json({
            retention: {
                joins7,
                leaves7,
                retained7Pct: Number((retained7 * 100).toFixed(1)),
                joins30,
                leaves30,
                retained30Pct: Number((retained30 * 100).toFixed(1))
            },
            activeHours: {
                timezone: 'UTC',
                histogram: hourMap,
                topHours: topActiveHours
            },
            toxicChannels,
            modSla: {
                medianResolutionHours: medianResolutionHours == null ? null : Number(medianResolutionHours.toFixed(2)),
                trends: modSlaTrends
            },
            newcomerConversion: {
                definition: 'Converted = at least 20 messages or level 2+',
                days7: { cohortSize: cohort7Size, converted: converted7, pct: cohort7Size ? Number(((converted7 / cohort7Size) * 100).toFixed(1)) : 0 },
                days30: { cohortSize: cohort30Size, converted: converted30, pct: cohort30Size ? Number(((converted30 / cohort30Size) * 100).toFixed(1)) : 0 }
            }
        });
    } catch (error) {
        console.error('Insights error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
