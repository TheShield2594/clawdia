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
        
        if (updates['dailyNews.enabled'] !== undefined || updates['dailyNews.time'] !== undefined) {
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

        res.json({
            totalUsers,
            totalMessages: totalMessages[0]?.total || 0,
            topLevels: topLevels.map(u => ({
                userId: u.userId,
                level: u.level,
                xp: u.xp
            }))
        });
    } catch (error) {
        console.error('Stats error:', error);
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