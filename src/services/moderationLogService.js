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

// The AI second opinion on a filter trip, as an embed field for the mod-log
// (#1017). Absent when there is no review — a guild with it off, no provider, an
// outage or a budget refusal — so the embed is unchanged for everyone who has
// not opted in.
function aiReviewField(review) {
    if (!review?.verdict) return null;
    const head = review.verdict === 'false_positive'
        ? '⚠️ Likely **false positive**'
        : '✅ Reads as a **genuine violation**';
    const reason = review.reason ? ` — ${review.reason}` : '';
    const model = review.model ? ` _(${review.model})_` : '';
    // Discord's field-value ceiling is 1,024; the reason is already clamped well
    // under it, but slice defensively so a long model name cannot push it over.
    return { name: '🤖 AI Review', value: `${head}${reason}${model}`.slice(0, 1024) };
}

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

                const reviewField = aiReviewField(options.aiReview);
                if (reviewField) embed.addFields(reviewField);

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
            duration: options.duration || null,
            aiReview: options.aiReview || null
        });
        return newCase;
    } catch (error) {
        console.error('Logger error:', error);
        return null;
    }
}

module.exports = { logModeration };
