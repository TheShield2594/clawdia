const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const { handleAutoModeration } = require('../services/autoModService');
const COLORS = require('../utils/embedColors');

module.exports = {
    name: 'messageUpdate',
    async execute(oldMessage, newMessage, _client) {
        if (newMessage.author?.bot || !newMessage.guild) return;
        if (oldMessage.content === newMessage.content) return;

        const guildSettings = await getGuildSettings(newMessage.guild.id);
        if (!guildSettings) return;

        // Auto-moderation only ever saw messageCreate, which left one opening
        // that needed no skill at all: post something harmless, then edit it
        // into the invite link, the slur, the wall of caps. The filters never
        // saw the text that ended up on screen.
        //
        // This runs before the edit log below and independently of it: a guild
        // that never turned event logging on is exactly a guild that would
        // never notice the hole.
        if (guildSettings.moderation?.enabled && guildSettings.moderation.scanEdits !== false) {
            try {
                const deleted = await handleAutoModeration(newMessage, guildSettings);
                // Nothing left to log an edit for, and the audit trail already
                // has the case the filter filed, with the offending text on it.
                if (deleted) return;
            } catch (err) {
                console.error('messageUpdate automod error:', err);
            }
        }

        if (!guildSettings.eventLog?.enabled || !guildSettings.eventLog.logMessageEdit) return;

        const logChannel = newMessage.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        if (!logChannel.permissionsFor(newMessage.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return;

        const embed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle('Message Edited')
            .setAuthor({ name: newMessage.author.globalName ?? newMessage.author.username, iconURL: newMessage.author.displayAvatarURL() })
            .addFields(
                { name: 'Before', value: (oldMessage.content || '*empty*').substring(0, 1024) },
                { name: 'After', value: (newMessage.content || '*empty*').substring(0, 1024) },
                { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
                { name: 'Jump', value: `[View Message](${newMessage.url})`, inline: true }
            )
            .setTimestamp();

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
};
