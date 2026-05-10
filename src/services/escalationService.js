const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const Case = require('../models/Case');
const TempBan = require('../models/TempBan');
const { createCase } = require('./caseService');

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

function findStepForCount(ladder, count) {
    if (!Array.isArray(ladder) || ladder.length === 0) return null;
    return ladder.find(step => step.threshold === count) || null;
}

function formatReason(template, count) {
    if (!template) return `Automatic escalation: ${count} warnings reached`;
    return template.replace(/\{count\}/g, String(count));
}

function simulate(ladder, count) {
    return findStepForCount(ladder, count);
}

async function postAutoCaseLog(guild, guildSettings, embed) {
    const channelId = guildSettings?.moderation?.logChannelId;
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;
    await channel.send({ embeds: [embed] }).catch(() => {});
}

async function applyEscalation({ guild, targetUser, warningCount, triggeringCase, client }) {
    const guildSettings = await Guild.findOne({ guildId: guild.id });
    const escalation = guildSettings?.moderation?.escalation;
    if (!escalation?.enabled) return null;

    const step = findStepForCount(escalation.ladder, warningCount);
    if (!step) return null;

    const reason = formatReason(step.reason, warningCount);
    const botUser = client.user;
    const member = await guild.members.fetch(targetUser.id).catch(() => null);
    let actionTaken = step.action;
    let durationMs = step.durationMinutes ? step.durationMinutes * 60 * 1000 : null;

    if (step.dmUser) {
        await targetUser.send(
            `You have been auto-${step.action}${durationMs ? `ed for ${step.durationMinutes} minute(s)` : (step.action.endsWith('e') ? 'd' : 'ed')} in **${guild.name}**: ${reason}`
        ).catch(() => {});
    }

    try {
        if (step.action === 'mute') {
            if (!member || !member.moderatable) {
                return { skipped: true, reason: 'Member not present or not moderatable.', step };
            }
            const timeoutMs = Math.min(durationMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
            await member.timeout(timeoutMs, reason);
        } else if (step.action === 'kick') {
            if (!member || !member.kickable) {
                return { skipped: true, reason: 'Member not present or not kickable.', step };
            }
            await member.kick(reason);
        } else if (step.action === 'ban') {
            if (member && !member.bannable) {
                return { skipped: true, reason: 'Member not bannable.', step };
            }
            await guild.members.ban(targetUser.id, { reason });
        } else if (step.action === 'tempban') {
            if (member && !member.bannable) {
                return { skipped: true, reason: 'Member not bannable.', step };
            }
            if (!durationMs) {
                return { skipped: true, reason: 'tempban step missing duration.', step };
            }
            await TempBan.findOneAndUpdate(
                { guildId: guild.id, userId: targetUser.id },
                { moderatorId: botUser.id, reason, expiresAt: new Date(Date.now() + durationMs) },
                { upsert: true }
            );
            await guild.members.ban(targetUser.id, { reason });
        }
    } catch (err) {
        console.error(`[ESCALATION] Failed to apply ${step.action} for ${targetUser.id} in ${guild.id}:`, err);
        return { error: true, step };
    }

    const caseType = step.action === 'tempban' ? 'ban' : step.action;
    const newCase = await createCase({
        guildId: guild.id,
        type: caseType,
        targetUserId: targetUser.id,
        moderatorId: botUser.id,
        reason,
        duration: durationMs ? Math.round(durationMs / 60000) : null
    });

    const embed = new EmbedBuilder()
        .setColor('#cc3300')
        .setTitle(`AutoMod | ${step.action.toUpperCase()} | ${targetUser.tag}`)
        .setDescription(`Triggered by warning threshold **${step.threshold}** (user reached **${warningCount}** active warnings).`)
        .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'Moderator', value: `${botUser.tag} (AutoMod)`, inline: true },
            { name: 'Action', value: step.action.toUpperCase(), inline: true },
            { name: 'Reason', value: reason }
        )
        .setTimestamp();

    if (durationMs) {
        embed.addFields({ name: 'Duration', value: `${step.durationMinutes} minute(s)`, inline: true });
    }
    if (triggeringCase?.caseId && triggeringCase.guildId) {
        embed.addFields({ name: 'Triggering Warning', value: `Case #${triggeringCase.caseId}`, inline: true });
    }
    if (newCase?.caseId) {
        embed.addFields({ name: 'Auto Case', value: `Case #${newCase.caseId}`, inline: true });
    }

    await postAutoCaseLog(guild, guildSettings, embed);

    return { applied: true, step, actionTaken, autoCase: newCase };
}

async function countActiveWarnings(guildId, userId) {
    return Case.countDocuments({ guildId, targetUserId: userId, type: 'warn' });
}

module.exports = {
    applyEscalation,
    simulate,
    findStepForCount,
    countActiveWarnings,
    formatReason
};
