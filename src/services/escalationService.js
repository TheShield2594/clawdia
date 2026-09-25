const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const Case = require('../models/Case');
const TempBan = require('../models/TempBan');
const { createCase } = require('./caseService');
const { hierarchyDenial, resolveMember } = require('../utils/moderationHierarchy');
const COLORS = require('../utils/embedColors');

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const ACTION_PAST_TENSE = {
    mute:    'muted',
    kick:    'kicked',
    ban:     'banned',
    tempban: 'temporarily banned'
};

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

/**
 * Why this rung cannot be applied to this member, or null when it can.
 *
 * Two separate questions, both of which have to pass. The bot's own power
 * (`moderatable` / `kickable` / `bannable`) says whether Discord will let the
 * bot do it. The hierarchy check says whether the moderator whose warning
 * tripped the rung could have done it themselves (#1144): a moderator who
 * cannot /kick a senior staffer must not be able to get them kicked by warning
 * them up the ladder instead.
 */
function stepRefusal(step, { member, indeterminate, moderator, durationMs }) {
    // A failed lookup is not "not a member". The ban rungs proceed on an
    // absent member (ban-by-id), so reading a 429 as absence would skip both
    // the bannable check and the hierarchy check below.
    if (indeterminate) return 'Could not look the member up just now.';

    if (member) {
        if (hierarchyDenial(moderator, member, step.action)) {
            return 'The warning moderator does not outrank this member.';
        }
    }

    if (step.action === 'mute') {
        if (!member || !member.moderatable) return 'Member not present or not moderatable.';
    } else if (step.action === 'kick') {
        if (!member || !member.kickable) return 'Member not present or not kickable.';
    } else if (step.action === 'ban' || step.action === 'tempban') {
        // member may be null if the user already left — Discord allows ban-by-ID.
        if (member && !member.bannable) return 'Member not bannable.';
        if (step.action === 'tempban' && !durationMs) return 'tempban step missing duration.';
    }
    return null;
}

/**
 * Apply the ladder rung, if any, that `warningCount` lands on.
 *
 * `moderator` is the GuildMember who issued the triggering warning. The rung
 * runs with their authority, so it is refused on anyone they do not outrank —
 * and an absent moderator fails closed, the way hierarchyDenial always does.
 */
async function applyEscalation({ guild, targetUser, warningCount, triggeringCase, client, moderator }) {
    const guildSettings = await Guild.findOne({ guildId: guild.id });
    const escalation = guildSettings?.moderation?.escalation;
    if (!escalation?.enabled) return null;

    const step = findStepForCount(escalation.ladder, warningCount);
    if (!step) return null;

    const reason = formatReason(step.reason, warningCount);
    const botUser = client.user;
    const { member, indeterminate } = await resolveMember(guild, targetUser.id);
    const actionTaken = step.action;
    const durationMs = step.durationMinutes ? step.durationMinutes * 60 * 1000 : null;

    const refusal = stepRefusal(step, { member, indeterminate, moderator, durationMs });
    if (refusal) return { skipped: true, reason: refusal, step };

    // After the checks, so a rung that is skipped does not tell the member
    // they were punished.
    if (step.dmUser) {
        const actionPast = ACTION_PAST_TENSE[step.action] || step.action;
        const durationSuffix = durationMs ? ` for ${step.durationMinutes} minute(s)` : '';
        await targetUser.send(
            `You have been auto-${actionPast}${durationSuffix} in **${guild.name}**: ${reason}`
        ).catch(() => {});
    }

    try {
        if (step.action === 'mute') {
            const timeoutMs = Math.min(durationMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
            await member.timeout(timeoutMs, reason);
        } else if (step.action === 'kick') {
            await member.kick(reason);
        } else if (step.action === 'ban') {
            await guild.members.ban(targetUser.id, { reason });
        } else if (step.action === 'tempban') {
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
        .setColor(COLORS.WARN)
        .setTitle(`AutoMod | ${step.action.toUpperCase()} | ${targetUser.globalName ?? targetUser.username}`)
        .setDescription(`Triggered by warning threshold **${step.threshold}** (user reached **${warningCount}** active warnings).`)
        .addFields(
            { name: 'User', value: `${targetUser.globalName ?? targetUser.username} (${targetUser.id})`, inline: true },
            { name: 'Moderator', value: `${botUser.globalName ?? botUser.username} (AutoMod)`, inline: true },
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

async function countWarnings(guildId, userId) {
    return Case.countDocuments({ guildId, targetUserId: userId, type: 'warn' });
}

module.exports = {
    applyEscalation,
    simulate,
    findStepForCount,
    countWarnings,
    formatReason
};
