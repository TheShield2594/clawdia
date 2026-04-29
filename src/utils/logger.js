const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');

async function logModeration(guildId, action, target, moderator, reason) {
    try {
        const guildSettings = await Guild.findOne({ guildId });
        
        if (!guildSettings || !guildSettings.moderation.logChannelId) return;

        const channel = moderator.client.channels.cache.get(guildSettings.moderation.logChannelId);
        if (!channel) return;

        const colors = {
            ban: '#ff0000',
            kick: '#ff9900',
            warn: '#ffff00',
            mute: '#ff6600'
        };

        const embed = new EmbedBuilder()
            .setColor(colors[action] || '#999999')
            .setTitle(`${action.toUpperCase()} | ${target.tag}`)
            .addFields(
                { name: 'User', value: `${target.tag} (${target.id})`, inline: true },
                { name: 'Moderator', value: `${moderator.tag}`, inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Logger error:', error);
    }
}

module.exports = { logModeration };