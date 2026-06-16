const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

router.post('/guild/:guildId/achievements/grant', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { userId, achievementId } = req.body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
        return res.status(400).json({ error: 'userId is required' });
    }
    if (!achievementId || typeof achievementId !== 'string' || !achievementId.trim()) {
        return res.status(400).json({ error: 'achievementId is required' });
    }

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        const trimmedId = achievementId.trim();
        const validAchievement = (guildSettings.achievements?.customAchievements || [])
            .find(a => a.id === trimmedId);
        if (!validAchievement) {
            return res.status(404).json({ error: 'Achievement not found in this server\'s custom achievements' });
        }

        const { grantCustomAchievement } = require('../../../services/achievementService');

        let user = await User.findOne({ userId: userId.trim(), guildId });
        if (!user) {
            user = await User.create({ userId: userId.trim(), guildId });
        }

        const granted = await grantCustomAchievement(user, trimmedId);
        user.markModified('achievements');
        await user.save();

        res.json({ success: true, granted });
    } catch (error) {
        console.error('Achievement grant error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
