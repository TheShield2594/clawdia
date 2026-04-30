const express = require('express');
const router = express.Router();
const Guild = require('../../models/Guild');
const { rescheduleDailyNews } = require('../../services/rssService');

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

router.post('/guild/:guildId/settings', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const updates = req.body;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        
        if (!guildSettings) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        Object.keys(updates).forEach(key => {
            if (key.includes('.')) {
                const [parent, child] = key.split('.');
                if (guildSettings[parent]) {
                    guildSettings[parent][child] = updates[key];
                }
            } else {
                guildSettings[key] = updates[key];
            }
        });

        await guildSettings.save();
        
        const shouldRescheduleDailyNews = Object.keys(updates).some(key => key.startsWith('dailyNews.') || key === 'dailyNewsProfiles');
        if (shouldRescheduleDailyNews) {
            rescheduleDailyNews(req.client, guildId);
        }
        
        res.json({ success: true, settings: guildSettings });
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/guild/:guildId/stats', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const User = require('../../models/User');

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

router.post('/guild/:guildId/autorole', checkAuth, checkGuildAccess, async (req, res) => {
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

router.delete('/guild/:guildId/autorole/:roleId', checkAuth, checkGuildAccess, async (req, res) => {
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

router.post('/guild/:guildId/rss/add', checkAuth, checkGuildAccess, async (req, res) => {
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

router.delete('/guild/:guildId/rss/:index', checkAuth, checkGuildAccess, async (req, res) => {
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
