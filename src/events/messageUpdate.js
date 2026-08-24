const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../utils/guildSettingsCache');

module.exports = {
    name: 'messageUpdate',
    async execute(oldMessage, newMessage, _client) {
        if (newMessage.author?.bot || !newMessage.guild) return;
        if (oldMessage.content === newMessage.content) return;

        const guildSettings = await getGuildSettings(newMessage.guild.id);
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logMessageEdit) return;

        const logChannel = newMessage.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        if (!logChannel.permissionsFor(newMessage.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return;

        const embed = new EmbedBuilder()
            .setColor('#FFA500')
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
