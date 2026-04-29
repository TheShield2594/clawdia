const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'guildMemberRemove',
    async execute(member, client) {
        try {
            const guildSettings = await Guild.findOne({ guildId: member.guild.id });
            
            if (!guildSettings || !guildSettings.farewell.enabled) return;
            
            const channel = member.guild.channels.cache.get(guildSettings.farewell.channelId);
            if (!channel) return;
            
            const message = guildSettings.farewell.message
                .replace(/{user}/g, member.user.tag)
                .replace(/{server}/g, member.guild.name)
                .replace(/{memberCount}/g, member.guild.memberCount);
            
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Goodbye!')
                .setDescription(message)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();
            
            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error in guildMemberRemove:', error);
        }
    }
};