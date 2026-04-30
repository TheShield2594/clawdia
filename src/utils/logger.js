const Guild = require('../models/Guild');
const { EmbedBuilder } = require('discord.js');
const { createCase } = require('../services/caseService');

async function logModeration(guildId, action, target, moderator, reason, options = {}) {
    try {
        const guildSettings = await Guild.findOne({ guildId });

        if (guildSettings?.moderation?.logChannelId) {
            const channel = moderator.client.channels.cache.get(guildSettings.moderation.logChannelId);
            if (channel) {
                const colors = {
                    ban: '#ff0000',
                    kick: '#ff9900',
                    warn: '#ffff00',
                    mute: '#ff6600',
                    unban: '#00ff00',
                    unmute: '#00ff00',
                    note: '#888888'
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

                if (options.duration) {
                    embed.addFields({ name: 'Duration', value: `${options.duration} minutes`, inline: true });
                }

                await channel.send({ embeds: [embed] });
            }
        }

        // Persist as a Case record
        await createCase({
            guildId,
            type: action,
            targetUserId: target.id,
            moderatorId: moderator.id,
            reason,
            evidence: options.evidence || null,
            duration: options.duration || null
        });
    } catch (error) {
        console.error('Logger error:', error);
    }
}

module.exports = { logModeration };
