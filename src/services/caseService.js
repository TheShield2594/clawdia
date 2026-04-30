const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');
const Case = require('../models/Case');
const Guild = require('../models/Guild');

async function getNextCaseId(guildId) {
    const result = await Guild.findOneAndUpdate(
        { guildId },
        { $inc: { 'caseSettings.nextCaseId': 1 } },
        { upsert: true, new: true, projection: { 'caseSettings.nextCaseId': 1 } }
    );
    // new:true returns the post-increment value; subtract 1 for the id we're assigning now
    return (result?.caseSettings?.nextCaseId ?? 2) - 1;
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
    return Case.findOneAndUpdate(
        { guildId, caseId },
        { $push: { notes: { moderatorId, content, createdAt: new Date() } } },
        { new: true }
    );
}

async function closeCase(guildId, caseId, moderatorId, resolution) {
    return Case.findOneAndUpdate(
        { guildId, caseId },
        {
            status: 'closed',
            resolvedAt: new Date(),
            resolvedBy: moderatorId,
            resolution
        },
        { new: true }
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
    cron.schedule('*/30 * * * *', async () => {
        try {
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
                    .setColor('#ff9900')
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
        } catch (err) {
            console.error('SLA monitor error:', err);
        }
    });
}

module.exports = { createCase, addNote, closeCase, getCase, getCasesForUser, startSlaMonitor };
