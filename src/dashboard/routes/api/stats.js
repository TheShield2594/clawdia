const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const Case = require('../../../models/Case');
const { checkAuth, checkGuildAccess } = require('../../lib/middleware');
const { computeRetention, median, parseChannelIdFromJumpUrl } = require('../../lib/apiHelpers');

router.get('/guild/:guildId/stats', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const totalUsers = await User.countDocuments({ guildId });
        const totalMessages = await User.aggregate([
            { $match: { guildId } },
            { $group: { _id: null, total: { $sum: '$messages' } } }
        ]);

        const topLevels = await User.find({ guildId })
            .sort({ level: -1, xp: -1 })
            .limit(10);
        const guildSettings = await Guild.findOne({ guildId });
        const memberEvents = guildSettings?.analytics?.memberEvents || [];
        const commandUsage = guildSettings?.analytics?.commandUsage || [];

        const { joins7, leaves7, joins30, leaves30, retained7, retained30 } = computeRetention(memberEvents);

        const commandSummary = {};
        const failedByReason = {};
        const bestTimesByChannel = {};
        for (const item of commandUsage) {
            commandSummary[item.command] = commandSummary[item.command] || { total: 0, failed: 0 };
            commandSummary[item.command].total += 1;
            if (!item.success) {
                commandSummary[item.command].failed += 1;
                failedByReason[item.reason || 'unknown'] = (failedByReason[item.reason || 'unknown'] || 0) + 1;
            }
            const channel = item.channelId || 'unknown';
            bestTimesByChannel[channel] = bestTimesByChannel[channel] || {};
            bestTimesByChannel[channel][item.hour] = (bestTimesByChannel[channel][item.hour] || 0) + 1;
        }
        const bestPostingTimes = Object.entries(bestTimesByChannel).map(([channelId, hours]) => {
            const bestHour = Object.entries(hours).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0';
            return { channelId, hourUtc: Number(bestHour) };
        }).slice(0, 8);

        const recommendations = [];
        if (leaves30 > joins30 * 0.6 && !guildSettings?.welcome?.dmEnabled) recommendations.push('Enable welcome DMs to improve first-week retention.');
        if (!guildSettings?.moderation?.enabled || !guildSettings?.moderation?.autoModEnabled) recommendations.push('Enable auto-moderation, your raid/spam risk is elevated.');
        if ((failedByReason.execution_error || 0) > 10) recommendations.push('High command error volume detected. Audit recent command updates.');
        if ((guildSettings?.rssFeeds?.length || 0) === 0) recommendations.push('Add RSS or Daily News automation to keep channels active.');

        // Member growth: derive from memberEvents (last 30 days)
        const now30 = Date.now();
        const memberGrowth = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now30 - i * 864e5).toISOString().slice(0, 10);
            const ev = memberEvents.find(e => e.date === d);
            memberGrowth.push({ date: d, joins: ev?.joins || 0, leaves: ev?.leaves || 0 });
        }

        // Message volume proxy: commandUsage events grouped by day (last 30 days)
        const msgVolMap = {};
        for (const ev of commandUsage) {
            if (ev.createdAt) {
                const d = new Date(ev.createdAt).toISOString().slice(0, 10);
                msgVolMap[d] = (msgVolMap[d] || 0) + 1;
            }
        }
        const messageVolume = memberGrowth.map(({ date }) => ({ date, count: msgVolMap[date] || 0 }));

        // Economy stats summary
        const [ecoTotalAgg, ecoActiveCount] = await Promise.all([
            User.aggregate([{ $match: { guildId } }, { $group: { _id: null, total: { $sum: { $add: ['$balance', '$bank'] } }, avgXp: { $avg: '$xp' } } }]),
            User.countDocuments({ guildId, $or: [
                { lastWork:  { $gte: new Date(now30 - 7 * 864e5) } },
                { lastDaily: { $gte: new Date(now30 - 7 * 864e5) } },
                { lastFish:  { $gte: new Date(now30 - 7 * 864e5) } },
                { lastMine:  { $gte: new Date(now30 - 7 * 864e5) } },
                { lastCrime: { $gte: new Date(now30 - 7 * 864e5) } },
                { lastHeist: { $gte: new Date(now30 - 7 * 864e5) } },
                { lastRob:   { $gte: new Date(now30 - 7 * 864e5) } }
            ] })
        ]);

        res.json({
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
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/guild/:guildId/insights', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        const memberEvents = guildSettings?.analytics?.memberEvents || [];
        const commandUsage = guildSettings?.analytics?.commandUsage || [];

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
        const recentCases = await Case.find({ guildId }).sort({ createdAt: -1 }).limit(1000);
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
        const now = Date.now();
        const users = await User.find({ guildId }).select('createdAt messages level');
        const cohort7 = users.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= 7 * 864e5);
        const cohort30 = users.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= 30 * 864e5);
        const isConverted = (u) => (u.messages || 0) >= 20 || (u.level || 0) >= 2;
        const converted7 = cohort7.filter(isConverted).length;
        const converted30 = cohort30.filter(isConverted).length;

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
                days7: { cohortSize: cohort7.length, converted: converted7, pct: cohort7.length ? Number(((converted7 / cohort7.length) * 100).toFixed(1)) : 0 },
                days30: { cohortSize: cohort30.length, converted: converted30, pct: cohort30.length ? Number(((converted30 / cohort30.length) * 100).toFixed(1)) : 0 }
            }
        });
    } catch (error) {
        console.error('Insights error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
