const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const Case = require('../models/Case');
const Guild = require('../models/Guild');
const { runJob } = require('../utils/jobRunner');
const COLORS = require('../utils/embedColors');

async function getNextCaseId(guildId) {
    // Aggregation-pipeline update atomically initializes nextCaseId to 1 when the field
    // is missing, or increments it — both in a single round-trip with no race window.
    // The returned value is the ID to assign directly (no subtract-1 needed).
    const result = await Guild.findOneAndUpdate(
        { guildId },
        [{ $set: { 'caseSettings.nextCaseId': { $ifNull: [{ $add: ['$caseSettings.nextCaseId', 1] }, 1] } } }],
        { updatePipeline: true, upsert: true, new: true, projection: { 'caseSettings.nextCaseId': 1 } }
    );
    return result.caseSettings.nextCaseId;
}

async function createCase({ guildId, type, targetUserId, moderatorId, reason, evidence = null, duration = null }) {
    try {
        const guildSettings = await Guild.findOne({ guildId });
        const slaHours = guildSettings?.caseSettings?.slaHours ?? 48;
        const slaDeadline = ['ban', 'kick', 'mute'].includes(type)
            ? new Date(Date.now() + slaHours * 3600000)
            : null;

        const caseId = await getNextCaseId(guildId);

        const newCase = await Case.create({
            caseId,
            guildId,
            targetUserId,
            moderatorId,
            type,
            reason,
            duration,
            evidence: evidence ?? {},
            status: 'open',
            slaDeadline
        });

        return newCase;
    } catch (err) {
        console.error('caseService.createCase error:', err);
        return null;
    }
}

async function addNote(guildId, caseId, moderatorId, content) {
    // A pipeline update so `firstActionAt` is stamped only if it is not already
    // set (#1015): the first note is the first response, and a later one must
    // not move the mark. `$ifNull` keeps an existing value and fills a null in
    // the same atomic write, with no read-back to race.
    return Case.findOneAndUpdate(
        { guildId, caseId },
        [
            { $set: {
                notes: { $concatArrays: [{ $ifNull: ['$notes', []] }, [{ moderatorId, content, createdAt: '$$NOW' }]] },
                firstActionAt: { $ifNull: ['$firstActionAt', '$$NOW'] }
            } }
        ],
        { updatePipeline: true, new: true }
    );
}

async function closeCase(guildId, caseId, moderatorId, resolution) {
    // Closing is a status change, so it counts as a first response for a case
    // nobody had touched yet — `$ifNull` sets `firstActionAt` only when it is
    // still empty (#1015).
    return Case.findOneAndUpdate(
        { guildId, caseId },
        [
            { $set: {
                status: 'closed',
                resolvedAt: '$$NOW',
                resolvedBy: moderatorId,
                resolution,
                firstActionAt: { $ifNull: ['$firstActionAt', '$$NOW'] }
            } }
        ],
        { updatePipeline: true, new: true }
    );
}

async function getCase(guildId, caseId) {
    return Case.findOne({ guildId, caseId });
}

async function getCasesForUser(guildId, targetUserId, limit = 10) {
    return Case.find({ guildId, targetUserId })
        .sort({ createdAt: -1 })
        .limit(limit);
}

function startSlaMonitor(client) {
    // Check every 30 minutes for overdue open cases
    cron.schedule('*/30 * * * *', () =>
        runJob('caseService', 'slaMonitor', async () => {
        const now = new Date();
            const overdueCases = await Case.find({
                status: 'open',
                slaDeadline: { $lte: now }
            });

            // Batch-fetch all guild settings to avoid N+1 queries
            const uniqueGuildIds = [...new Set(overdueCases.map(c => c.guildId))];
            const guildDocs = await Guild.find({ guildId: { $in: uniqueGuildIds } });
            const guildMap = new Map(guildDocs.map(g => [g.guildId, g]));

            for (const modCase of overdueCases) {
                const guildSettings = guildMap.get(modCase.guildId);
                const slaChannelId = guildSettings?.caseSettings?.slaChannelId
                    || guildSettings?.moderation?.logChannelId;
                if (!slaChannelId) continue;

                const guild = client.guilds.cache.get(modCase.guildId);
                if (!guild) continue;
                const channel = guild.channels.cache.get(slaChannelId);
                if (!channel) continue;

                const embed = new EmbedBuilder()
                    .setColor(COLORS.WARN)
                    .setTitle('SLA Overdue — Open Case')
                    .setDescription(`Case **#${modCase.caseId}** has exceeded its SLA deadline and is still open.`)
                    .addFields(
                        { name: 'Type', value: modCase.type.toUpperCase(), inline: true },
                        { name: 'Target', value: `<@${modCase.targetUserId}>`, inline: true },
                        { name: 'Opened', value: `<t:${Math.floor(modCase.createdAt.getTime() / 1000)}:R>`, inline: true },
                        { name: 'Reason', value: modCase.reason ?? 'No reason provided' }
                    )
                    .setTimestamp();

                await channel.send({ embeds: [embed] }).catch(console.error);

                // Push deadline forward by SLA window to avoid repeat pings every 30m
                const slaHours = guildSettings?.caseSettings?.slaHours ?? 48;
                await Case.updateOne(
                    { _id: modCase._id },
                    { slaDeadline: new Date(Date.now() + slaHours * 3600000) }
                );
            }
        })
    );
}

module.exports = { createCase, addNote, closeCase, getCase, getCasesForUser, startSlaMonitor };
