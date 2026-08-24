const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../utils/guildSettingsCache');

module.exports = {
    name: 'messageDelete',
    async execute(message, _client) {
        if (message.author?.bot || !message.guild) return;

        const guildSettings = await getGuildSettings(message.guild.id);
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logMessageDelete) return;

        const logChannel = message.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        if (!logChannel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return;

        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('Message Deleted')
            .setAuthor({ name: message.author?.globalName ?? message.author?.username ?? 'Unknown', iconURL: message.author?.displayAvatarURL() })
            .addFields(
                { name: 'Content', value: (message.content || '*no text content*').substring(0, 1024) },
                { name: 'Channel', value: `<#${message.channel.id}>`, inline: true }
            )
            .setTimestamp();

        if (message.attachments.size > 0) {
            embed.addFields({ name: 'Attachments', value: message.attachments.map(a => a.name).join(', '), inline: true });
        }

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
};
