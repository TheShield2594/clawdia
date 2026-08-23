'use strict';

// Moderation logging: post the action to the guild's log channel and persist it
// as a Case.
//
// This was `utils/logger.js`, and it imported `services/caseService` — a util
// reaching up into a service, which is the direction the layer rule refuses
// (#614). It was never a utility: it reads a Guild, writes a Case and talks to
// Discord. Naming it for what it does put it where it belongs.

const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const { createCase } = require('./caseService');

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
                    .setTitle(`${action.toUpperCase()} | ${target.globalName ?? target.username}`)
                    .addFields(
                        { name: 'User', value: `${target.globalName ?? target.username} (${target.id})`, inline: true },
                        { name: 'Moderator', value: `${moderator.globalName ?? moderator.username}`, inline: true },
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
        const newCase = await createCase({
            guildId,
            type: action,
            targetUserId: target.id,
            moderatorId: moderator.id,
            reason,
            evidence: options.evidence || null,
            duration: options.duration || null
        });
        return newCase;
    } catch (error) {
        console.error('Logger error:', error);
        return null;
    }
}

module.exports = { logModeration };
