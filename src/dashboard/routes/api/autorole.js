const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');
const { describeSensitivePermissions } = require('../../../utils/sensitiveRolePermissions');

// Adds a role to the set every new member is given on join.
router.post('/guild/:guildId/autorole', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { roleId } = req.body;

    if (!roleId) return res.status(400).json({ error: 'roleId required' });
    if (!isValidDiscordId(roleId)) return res.status(400).json({ error: 'roleId must be a valid Discord snowflake' });

    try {
        // Autorole gives this role to every joiner, so a role carrying admin or
        // moderator permissions must not be one of them — that would elevate
        // every new member (#1061).
        const roles = await req.bot.listRoles(guildId);
        const role = (roles || []).find(r => r.id === roleId);
        if (role?.dangerousPermissions?.length) {
            return res.status(400).json({
                error: `The "${role.name}" role grants ${describeSensitivePermissions(role.dangerousPermissions)} `
                    + 'and cannot be handed out automatically to new members.',
            });
        }

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

// Stops giving a role to new members on join.
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
