const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');

module.exports = {
    name: 'messageDelete',
    async execute(message, client) {
        if (message.author?.bot || !message.guild) return;

        const guildSettings = await Guild.findOne({ guildId: message.guild.id });
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logMessageDelete) return;

        const logChannel = message.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('Message Deleted')
            .setAuthor({ name: message.author?.tag ?? 'Unknown', iconURL: message.author?.displayAvatarURL({ dynamic: true }) })
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
