const express = require('express');
const router = express.Router();
const Guild = require('../../models/Guild');
const Case = require('../../models/Case');
const User = require('../../models/User');
const { rescheduleDailyNews } = require('../../services/rssService');
const { rescheduleBibleVerse } = require('../../services/dailyBibleService');
const Parser = require('rss-parser');

function median(nums) {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseChannelIdFromJumpUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const parts = url.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function checkGuildAccess(req, res, next) {
    const { guildId } = req.params;
    const userGuilds = req.user.guilds.filter(guild =>
        (guild.permissions & 0x20) === 0x20 && req.client.guilds.cache.has(guild.id)
    );

    if (!userGuilds.find(g => g.id === guildId)) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    next();
}

// In-memory rate limiter for write operations: 60 requests per minute per user
const writeRateLimits = new Map();
setInterval(() => {
    const cutoff = Date.now() - 60 * 1000;
    for (const [userId, timestamps] of writeRateLimits) {
        if (timestamps.every(t => t < cutoff)) writeRateLimits.delete(userId);
    }
}, 5 * 60 * 1000);

function checkWriteRateLimit(req, res, next) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const now = Date.now();
    const windowMs = 60 * 1000;
    const limit = 60;
    const arr = (writeRateLimits.get(userId) || []).filter(t => now - t < windowMs);

    if (arr.length >= limit) {
        writeRateLimits.set(userId, arr);
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }

    arr.push(now);
    writeRateLimits.set(userId, arr);
    next();
}

router.post('/guild/:guildId/settings', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const updates = req.body;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        
        if (!guildSettings) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        Object.keys(updates).forEach(key => {
            if (key.includes('.')) {
                const parts = key.split('.');
                const parent = parts[0];
                const child = parts.slice(1).join('.');
                if (guildSettings[parent] == null) {
                    guildSettings[parent] = {};
                }
                guildSettings[parent][child] = updates[key];
            } else {
                guildSettings[key] = updates[key];
            }
        });

        await guildSettings.save();
        
        const shouldRescheduleDailyNews = Object.keys(updates).some(key => key.startsWith('dailyNews.') || key === 'dailyNewsProfiles');
        if (shouldRescheduleDailyNews) {
            rescheduleDailyNews(req.client, guildId);
        }

        const shouldRescheduleBible = Object.keys(updates).some(key => key.startsWith('bibleVerse.'));
        if (shouldRescheduleBible) {
            rescheduleBibleVerse(req.client, guildId);
        }
        
        res.json({ success: true, settings: guildSettings });
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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
            .limit(5);
        const guildSettings = await Guild.findOne({ guildId });
        const memberEvents = guildSettings?.analytics?.memberEvents || [];
        const commandUsage = guildSettings?.analytics?.commandUsage || [];

        const joins30 = memberEvents.slice(-30).reduce((a, d) => a + (d.joins || 0), 0);
        const leaves30 = memberEvents.slice(-30).reduce((a, d) => a + (d.leaves || 0), 0);
        const retained7 = Math.max(0, joins30 - leaves30) / Math.max(joins30, 1);
        const retained30 = Math.max(0, joins30 - Math.round(leaves30 * 1.2)) / Math.max(joins30, 1);

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
                recommendations
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
        const joins7 = memberEvents.slice(-7).reduce((a, d) => a + (d.joins || 0), 0);
        const leaves7 = memberEvents.slice(-7).reduce((a, d) => a + (d.leaves || 0), 0);
        const joins30 = memberEvents.slice(-30).reduce((a, d) => a + (d.joins || 0), 0);
        const leaves30 = memberEvents.slice(-30).reduce((a, d) => a + (d.leaves || 0), 0);
        const retained7 = joins7 ? Math.max(0, joins7 - leaves7) / joins7 : 0;
        const retained30 = joins30 ? Math.max(0, joins30 - leaves30) / joins30 : 0;

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

router.post('/guild/:guildId/autorole', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { roleId } = req.body;

    if (!roleId) return res.status(400).json({ error: 'roleId required' });

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        if (!guildSettings.autoRoles.some(r => r.roleId === roleId)) {
            guildSettings.autoRoles.push({ roleId });
            await guildSettings.save();
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Autorole add error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/guild/:guildId/autorole/:roleId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, roleId } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        guildSettings.autoRoles = guildSettings.autoRoles.filter(r => r.roleId !== roleId);
        await guildSettings.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Autorole remove error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/guild/:guildId/reactionrole/panel', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, title, description, mappings } = req.body;

    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!Array.isArray(mappings) || !mappings.length) return res.status(400).json({ error: 'At least one emoji/role mapping is required' });

    for (const m of mappings) {
        if (!m || typeof m.emoji !== 'string' || !m.emoji.trim() ||
            typeof m.roleId !== 'string' || !m.roleId.trim()) {
            return res.status(400).json({ error: 'Each mapping must have a non-empty emoji and roleId' });
        }
    }

    const emojiValues = mappings.map(m => m.emoji.trim());
    if (new Set(emojiValues).size !== emojiValues.length) {
        return res.status(400).json({ error: 'Duplicate emoji values are not allowed within the same panel' });
    }

    try {
        const guild = req.client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const channel = guild.channels.cache.get(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild settings not found' });

        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(title || 'React to get a role!')
            .setDescription(
                (description ? description + '\n\n' : '') +
                mappings.map(m => `${m.emoji.trim()} — <@&${m.roleId.trim()}>`).join('\n')
            )
            .setFooter({ text: 'React below to assign yourself a role' });

        const message = await channel.send({ embeds: [embed] });

        try {
            for (const mapping of mappings) {
                const emojiStr = mapping.emoji.trim();
                const match = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
                const reactArg = match ? `${match[1]}:${match[2]}` : emojiStr;
                await message.react(reactArg);
            }

            for (const mapping of mappings) {
                guildSettings.reactionRoles.push({
                    messageId: message.id,
                    channelId,
                    emoji: mapping.emoji.trim(),
                    roleId: mapping.roleId.trim()
                });
            }

            await guildSettings.save();
        } catch (innerError) {
            await message.delete().catch(() => null);
            throw innerError;
        }

        res.json({ success: true, messageId: message.id });
    } catch (error) {
        console.error('Reaction role panel create error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/guild/:guildId/reactionrole/panel/:messageId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, messageId } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        const entry = guildSettings.reactionRoles.find(r => r.messageId === messageId);
        if (entry) {
            const guild = req.client.guilds.cache.get(guildId);
            if (guild) {
                const channel = guild.channels.cache.get(entry.channelId);
                if (channel) {
                    await channel.messages.fetch(messageId).then(m => m.delete()).catch(() => null);
                }
            }
        }

        guildSettings.reactionRoles = guildSettings.reactionRoles.filter(r => r.messageId !== messageId);
        await guildSettings.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Reaction role panel delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/guild/:guildId/validate-feed', checkAuth, checkGuildAccess, async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ valid: false, error: 'No URL provided.' });
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.json({ valid: false, error: 'Invalid URL format.' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.json({ valid: false, error: 'URL must use http or https.' });
    }

    try {
        const feedParser = new Parser({ timeout: 8000 });
        const feed = await feedParser.parseURL(url);
        return res.json({ valid: true, title: feed.title || '', itemCount: feed.items?.length ?? 0 });
    } catch (err) {
        return res.json({ valid: false, error: 'Could not fetch or parse feed. Check the URL and ensure it is a valid RSS/Atom feed.' });
    }
});

router.post('/guild/:guildId/rss/add', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { url, channelId } = req.body;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        
        guildSettings.rssFeeds.push({ url, channelId });
        await guildSettings.save();

        res.json({ success: true });
    } catch (error) {
        console.error('RSS add error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/guild/:guildId/rss/:index', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, index } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        
        guildSettings.rssFeeds.splice(parseInt(index), 1);
        await guildSettings.save();

        res.json({ success: true });
    } catch (error) {
        console.error('RSS delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
