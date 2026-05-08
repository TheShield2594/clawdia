const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');

// guildId -> [{timestamp, userId, accountAgeDays}]
// NOTE: in-memory only — data is lost on restart and not shared across shards.
// For multi-shard or high-availability deployments, replace with a Redis-backed
// store using sorted sets (ZADD/ZRANGEBYSCORE with TTL) for atomic, shared state.
const joinLog = new Map();

// Tracks which guilds are currently in active raid mode (in-memory mirror of DB field).
const raidModeActive = new Set();
// 'auto' | 'manual' per guild
const raidModeActivatedBy = new Map();
// Last join timestamp per guild (used for calm-window detection)
const lastJoinTime = new Map();

function pruneLog(guildId, windowMs) {
    const now = Date.now();
    const entries = (joinLog.get(guildId) || []).filter(e => now - e.timestamp < windowMs);
    joinLog.set(guildId, entries);
    return entries;
}

async function applyRaidAction(member, rd, minAccountAgeDays) {
    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    if (accountAgeDays >= minAccountAgeDays) return;

    if (rd.action === 'kick' && member.kickable) {
        await member.kick('[AutoMod] Raid mode active — new account').catch(console.error);
    } else if (rd.action === 'quarantine' && rd.quarantineRoleId) {
        const role = member.guild.roles.cache.get(rd.quarantineRoleId);
        if (role) await member.roles.add(role).catch(console.error);
    }
}

async function handleMemberJoin(member, client) {
    const guildId = member.guild.id;

    let guildSettings;
    try {
        guildSettings = await Guild.findOne({ guildId });
    } catch (err) {
        console.error(`[RaidService] DB error fetching guild ${guildId}:`, err);
        return;
    }

    if (!guildSettings?.raidDetection?.enabled) return;

    const rd = guildSettings.raidDetection;
    const windowMs = (rd.windowSeconds || 60) * 1000;
    const threshold = rd.threshold || 10;
    const minAccountAgeDays = rd.minAccountAgeDays || 7;

    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000;

    const entries = pruneLog(guildId, windowMs);
    entries.push({ timestamp: Date.now(), userId: member.id, accountAgeDays });
    joinLog.set(guildId, entries);
    lastJoinTime.set(guildId, Date.now());

    // Sync in-memory state from DB on the first join we see for this guild after a restart
    if (!raidModeActive.has(guildId) && rd.raidModeActive) {
        raidModeActive.add(guildId);
        raidModeActivatedBy.set(guildId, rd.raidModeActivatedBy || 'manual');
    }

    // If raid mode is already active, apply the configured action to every new join
    if (raidModeActive.has(guildId)) {
        await applyRaidAction(member, rd, minAccountAgeDays);
        return;
    }

    // Not yet in raid mode — check whether the threshold has been exceeded
    if (entries.length < threshold) return;

    // Threshold crossed: auto-enable raid mode
    const alertChannelId = rd.alertChannelId || guildSettings.moderation?.logChannelId;
    const alertChannel = alertChannelId ? member.guild.channels.cache.get(alertChannelId) : null;

    const newAccounts = entries.filter(e => e.accountAgeDays < minAccountAgeDays).length;

    const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('⚠️ Raid Detected! Raid Mode Auto-Enabled')
        .setDescription(
            `**${entries.length}** members joined within **${rd.windowSeconds}s** (threshold: ${threshold})`
        )
        .addFields(
            { name: 'New Accounts', value: `${newAccounts} joined with accounts < ${minAccountAgeDays} days old`, inline: true },
            { name: 'Action', value: rd.action.toUpperCase(), inline: true },
            { name: 'Triggered By', value: 'Automatic', inline: true }
        )
        .setTimestamp();

    if (alertChannel) {
        await alertChannel.send({ embeds: [embed] }).catch(console.error);
    }

    raidModeActive.add(guildId);
    raidModeActivatedBy.set(guildId, 'auto');

    await Guild.updateOne({ guildId }, {
        $set: {
            'raidDetection.raidModeActive': true,
            'raidDetection.raidModeActivatedBy': 'auto',
            'raidDetection.raidModeActivatedAt': new Date()
        }
    }).catch(console.error);

    // Apply action to all members in the current window
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

// Called by /raidmode toggle to manually enable or disable raid mode.
async function setRaidMode(guildId, guild, active, guildSettings) {
    const rd = guildSettings.raidDetection;
    const alertChannelId = rd.alertChannelId || guildSettings.moderation?.logChannelId;
    const alertChannel = alertChannelId ? guild.channels.cache.get(alertChannelId) : null;

    if (active) {
        raidModeActive.add(guildId);
        raidModeActivatedBy.set(guildId, 'manual');

        await Guild.updateOne({ guildId }, {
            $set: {
                'raidDetection.raidModeActive': true,
                'raidDetection.raidModeActivatedBy': 'manual',
                'raidDetection.raidModeActivatedAt': new Date()
            }
        });

        if (alertChannel) {
            const embed = new EmbedBuilder()
                .setColor('#ff9900')
                .setTitle('🔒 Raid Mode Manually Enabled')
                .setDescription('Raid mode has been manually enabled by a moderator.')
                .setTimestamp();
            await alertChannel.send({ embeds: [embed] }).catch(console.error);
        }
    } else {
        raidModeActive.delete(guildId);
        raidModeActivatedBy.delete(guildId);

        await Guild.updateOne({ guildId }, {
            $set: {
                'raidDetection.raidModeActive': false,
                'raidDetection.raidModeActivatedBy': null,
                'raidDetection.raidModeActivatedAt': null
            }
        });

        if (alertChannel) {
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('🔓 Raid Mode Manually Disabled')
                .setDescription('Raid mode has been manually disabled by a moderator.')
                .setTimestamp();
            await alertChannel.send({ embeds: [embed] }).catch(console.error);
        }
    }
}

// Periodic tick: auto-disable raid mode once the server calms down.
function startRaidMonitor(client) {
    setInterval(async () => {
        if (raidModeActive.size === 0) return;

        for (const guildId of [...raidModeActive]) {
            // Never auto-disable a manually activated raid mode
            if (raidModeActivatedBy.get(guildId) === 'manual') continue;

            let guildSettings;
            try {
                guildSettings = await Guild.findOne({ guildId });
            } catch (err) {
                console.error(`[RaidService] DB error fetching guild ${guildId}:`, err);
                continue;
            }

            if (!guildSettings?.raidDetection?.enabled) {
                raidModeActive.delete(guildId);
                raidModeActivatedBy.delete(guildId);
                continue;
            }

            const rd = guildSettings.raidDetection;

            if (!rd.autoDisable || rd.requireManualDisable) continue;

            const calmWindowMs = (rd.calmWindowSeconds || 300) * 1000;
            const last = lastJoinTime.get(guildId) || 0;

            // Require silence for the full calm window before auto-disabling
            if (Date.now() - last < calmWindowMs) continue;

            // Also verify the window itself has fewer than 2 joins
            const entries = pruneLog(guildId, calmWindowMs);
            if (entries.length >= 2) continue;

            raidModeActive.delete(guildId);
            raidModeActivatedBy.delete(guildId);

            await Guild.updateOne({ guildId }, {
                $set: {
                    'raidDetection.raidModeActive': false,
                    'raidDetection.raidModeActivatedBy': null,
                    'raidDetection.raidModeActivatedAt': null
                }
            }).catch(console.error);

            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;

            const alertChannelId = rd.alertChannelId || guildSettings.moderation?.logChannelId;
            const alertChannel = alertChannelId ? guild.channels.cache.get(alertChannelId) : null;

            if (alertChannel) {
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('✅ Raid Stopped — Raid Mode Auto-Disabled')
                    .setDescription('Raid appears to have stopped. Raid mode auto-disabled.')
                    .setTimestamp();
                await alertChannel.send({ embeds: [embed] }).catch(console.error);
            }
        }
    }, 60_000);
}

module.exports = { handleMemberJoin, startRaidMonitor, setRaidMode, raidModeActive, raidModeActivatedBy };
