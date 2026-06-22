const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');

router.post('/guild/:guildId/autorole', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { roleId } = req.body;

    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    if (!isValidDiscordId(roleId)) return res.status(400).json({ error: 'roleId must be a valid Discord snowflake' });

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

module.exports = router;
