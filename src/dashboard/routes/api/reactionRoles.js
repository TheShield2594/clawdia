const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');

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

module.exports = router;
