const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');

// guildId -> [{timestamp, userId, accountAgeDays}]
const joinLog = new Map();

function pruneLog(guildId, windowMs) {
    const now = Date.now();
    const entries = (joinLog.get(guildId) || []).filter(e => now - e.timestamp < windowMs);
    joinLog.set(guildId, entries);
    return entries;
}

async function handleMemberJoin(member, client) {
    const guildId = member.guild.id;

    let guildSettings;
    try {
        guildSettings = await Guild.findOne({ guildId });
    } catch { return; }

    if (!guildSettings?.raidDetection?.enabled) return;

    const rd = guildSettings.raidDetection;
    const windowMs = (rd.windowSeconds || 60) * 1000;
    const threshold = rd.threshold || 10;
    const minAccountAgeDays = rd.minAccountAgeDays || 7;

    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000;

    const entries = pruneLog(guildId, windowMs);
    entries.push({ timestamp: Date.now(), userId: member.id, accountAgeDays });
    joinLog.set(guildId, entries);

    if (entries.length < threshold) return;

    // Raid triggered — clear log to avoid repeated triggers within same window
    joinLog.set(guildId, []);

    const alertChannelId = rd.alertChannelId || guildSettings.moderation?.logChannelId;
    const alertChannel = alertChannelId ? member.guild.channels.cache.get(alertChannelId) : null;

    const newAccounts = entries.filter(e => e.accountAgeDays < minAccountAgeDays).length;

    const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('RAID DETECTED')
        .setDescription(`**${entries.length}** members joined within **${rd.windowSeconds}s** (threshold: ${threshold})`)
        .addFields(
            { name: 'New Accounts', value: `${newAccounts} joined with accounts < ${minAccountAgeDays} days old`, inline: true },
            { name: 'Action', value: rd.action.toUpperCase(), inline: true }
        )
        .setTimestamp();

    if (alertChannel) {
        await alertChannel.send({ embeds: [embed] }).catch(console.error);
    }

    if (rd.action === 'kick' || rd.action === 'quarantine') {
        for (const entry of entries) {
            if (entry.accountAgeDays >= minAccountAgeDays) continue;
            const raidMember = member.guild.members.cache.get(entry.userId);
            if (!raidMember) continue;

            if (rd.action === 'kick' && raidMember.kickable) {
                await raidMember.kick('[AutoMod] Raid detection — new account').catch(console.error);
            } else if (rd.action === 'quarantine' && rd.quarantineRoleId) {
                const role = member.guild.roles.cache.get(rd.quarantineRoleId);
                if (role) await raidMember.roles.add(role).catch(console.error);
            }
        }
    }
}

module.exports = { handleMemberJoin };
