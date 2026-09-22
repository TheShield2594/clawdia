const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');
// Grouped the same way the settings page groups it, so the list the browser
// re-renders after a mutation matches the one a reload would produce (#689).
const { groupReactionRolePanels } = require('../../lib/reactionRolePanels');
const { describeSensitivePermissions } = require('../../../utils/sensitiveRolePermissions');

// Posts a reaction role panel to a channel and stores its emoji-to-role mappings.
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
        if (!isValidDiscordId(m.roleId.trim())) {
            return res.status(400).json({ error: `Invalid roleId: ${m.roleId} — must be a valid Discord snowflake` });
        }
    }

    const emojiValues = mappings.map(m => m.emoji.trim());
    if (new Set(emojiValues).size !== emojiValues.length) {
        return res.status(400).json({ error: 'Duplicate emoji values are not allowed within the same panel' });
    }

    try {
        if (!await req.bot.hasGuild(guildId)) return res.status(404).json({ error: 'Guild not found' });
        if (!await req.bot.hasChannel(guildId, channelId)) return res.status(404).json({ error: 'Channel not found' });

        // A member reacts to get one of these roles, so a role carrying admin or
        // moderator permissions must not be on the panel — that would let anyone
        // who can see it hand themselves those permissions (#1061). Checked
        // before the embed goes out so a rejected panel is never posted.
        const roles = await req.bot.listRoles(guildId);
        const rolesById = new Map((roles || []).map(role => [role.id, role]));
        for (const m of mappings) {
            const role = rolesById.get(m.roleId.trim());
            if (role?.dangerousPermissions?.length) {
                return res.status(400).json({
                    error: `The "${role.name}" role grants ${describeSensitivePermissions(role.dangerousPermissions)} `
                        + 'and cannot be handed out through a reaction-role panel.',
                });
            }
        }

        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild settings not found' });

        // Plain embed JSON rather than an EmbedBuilder: the gateway facade
        // takes data, so this route needs nothing from discord.js (#608).
        const embed = {
            color: 0x5865F2,
            title: title || 'React to get a role!',
            description:
                (description ? description + '\n\n' : '') +
                mappings.map(m => `${m.emoji.trim()} — <@&${m.roleId.trim()}>`).join('\n'),
            footer: { text: 'React below to assign yourself a role' },
        };

        const sent = await req.bot.sendEmbed(guildId, channelId, embed);
        if (!sent) return res.status(404).json({ error: 'Channel not found' });

        try {
            await req.bot.addReactions(guildId, channelId, sent.messageId, mappings.map(mapping => {
                const emojiStr = mapping.emoji.trim();
                const match = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
                return match ? `${match[1]}:${match[2]}` : emojiStr;
            }));

            for (const mapping of mappings) {
                guildSettings.reactionRoles.push({
                    messageId: sent.messageId,
                    channelId,
                    emoji: mapping.emoji.trim(),
                    roleId: mapping.roleId.trim()
                });
            }

            await guildSettings.save();
        } catch (innerError) {
            // A panel whose reactions or settings write failed is a message
            // nobody can use, so it does not get to stay up.
            await req.bot.deleteMessage(guildId, channelId, sent.messageId);
            throw innerError;
        }

        // The whole list, not just the panel that was published: the page
        // patches its list in place rather than reloading (#689).
        res.json({
            success: true,
            messageId: sent.messageId,
            panels: groupReactionRolePanels(guildSettings.reactionRoles),
        });
    } catch (error) {
        console.error('Reaction role panel create error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Deletes a reaction role panel, both the stored mappings and the Discord message.
router.delete('/guild/:guildId/reactionrole/panel/:messageId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, messageId } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        const entry = guildSettings.reactionRoles.find(r => r.messageId === messageId);
        if (entry) {
            await req.bot.deleteMessage(guildId, entry.channelId, messageId);
        }

        guildSettings.reactionRoles = guildSettings.reactionRoles.filter(r => r.messageId !== messageId);
        await guildSettings.save();

        res.json({ success: true, panels: groupReactionRolePanels(guildSettings.reactionRoles) });
    } catch (error) {
        console.error('Reaction role panel delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
