const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');

module.exports = {
    name: 'messageUpdate',
    async execute(oldMessage, newMessage, client) {
        if (newMessage.author?.bot || !newMessage.guild) return;
        if (oldMessage.content === newMessage.content) return;

        const guildSettings = await Guild.findOne({ guildId: newMessage.guild.id });
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logMessageEdit) return;

        const logChannel = newMessage.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('Message Edited')
            .setAuthor({ name: newMessage.author.tag, iconURL: newMessage.author.displayAvatarURL({ dynamic: true }) })
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
