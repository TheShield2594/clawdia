const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');
const Guild = require('../models/Guild');

// Permission keys the lockdown engine touches. Used to compute proper
// per-key restoration from the original allow/deny bitfields.
const LOCKDOWN_KEYS = [
    'SendMessages',
    'SendMessagesInThreads',
    'CreatePublicThreads',
    'CreatePrivateThreads',
    'AddReactions'
];

// Per-guild, per-actor sliding-window counters keyed by action type.
// Shape: Map<guildId, Map<actorId, Map<actionType, number[]>>>
// In-memory only — resets on restart. Acceptable since nuke bursts happen in
// seconds; long-term persistence would not change behavior.
const actionLog = new Map();

// Recent guilds we've already punished within the cooldown window. Prevents
// repeated punishment loops while audit-log fetches catch up.
const recentlyPunished = new Map(); // key: `${guildId}:${actorId}` -> timestamp
const PUNISH_COOLDOWN_MS = 30_000;

function getActorBucket(guildId, actorId) {
    let g = actionLog.get(guildId);
    if (!g) { g = new Map(); actionLog.set(guildId, g); }
    let a = g.get(actorId);
    if (!a) { a = new Map(); g.set(actorId, a); }
    return a;
}

function pruneAndPush(bucket, action, windowMs) {
    const now = Date.now();
    const arr = (bucket.get(action) || []).filter(t => now - t < windowMs);
    arr.push(now);
    bucket.set(action, arr);
    return arr.length;
}

function isWhitelisted(member, settings) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    if (member.user?.bot && member.id === member.client.user.id) return true;
    const wl = settings.antiNuke || {};
    if ((wl.whitelistUserIds || []).includes(member.id)) return true;
    const roleIds = member.roles?.cache ? [...member.roles.cache.keys()] : [];
    return (wl.whitelistRoleIds || []).some(r => roleIds.includes(r));
}

// Fetch the most recent audit log entry of `actionType` and return the executor
// member, if available and the entry is recent enough. Returns null on failure
// or when the entry is stale/self.
async function resolveExecutor(guild, actionType, targetId, maxAgeMs = 10_000) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
    try {
        const logs = await guild.fetchAuditLogs({ type: actionType, limit: 5 });
        const entry = logs.entries.find(e => {
            if (Date.now() - e.createdTimestamp > maxAgeMs) return false;
            if (targetId && e.target?.id !== targetId) return false;
            return true;
        });
        if (!entry || !entry.executor) return null;
        if (entry.executor.id === guild.client.user.id) return null;
        return await guild.members.fetch(entry.executor.id).catch(() => null);
    } catch (err) {
        console.error('[AntiNuke] Audit log fetch failed:', err);
        return null;
    }
}

async function alert(guild, settings, embed) {
    const id = settings.antiNuke?.alertChannelId || settings.moderation?.logChannelId;
    if (!id) return;
    const channel = guild.channels.cache.get(id);
    if (!channel?.isTextBased?.()) return;
    await channel.send({ embeds: [embed] }).catch(() => null);
}

async function punish(member, settings, action, count) {
    const key = `${member.guild.id}:${member.id}`;
    const last = recentlyPunished.get(key) || 0;
    if (Date.now() - last < PUNISH_COOLDOWN_MS) return;
    recentlyPunished.set(key, Date.now());

    const an = settings.antiNuke || {};
    const punishment = an.punishment || 'strip-roles';
    const reason = `[AntiNuke] Burst of ${action} (${count} in ${an.windowSeconds || 30}s)`;

    const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('Anti-Nuke Triggered')
        .setDescription(`Detected destructive burst by ${member.user.tag} (${member.id})`)
        .addFields(
            { name: 'Action', value: action, inline: true },
            { name: 'Count',  value: `${count}`, inline: true },
            { name: 'Window', value: `${an.windowSeconds || 30}s`, inline: true },
            { name: 'Punishment', value: punishment, inline: true }
        )
        .setTimestamp();

    await alert(member.guild, settings, embed);

    try {
        if (punishment === 'ban' && member.bannable) {
            await member.ban({ reason, deleteMessageSeconds: 0 });
        } else if (punishment === 'kick' && member.kickable) {
            await member.kick(reason);
        } else if (punishment === 'strip-roles' && member.manageable) {
            const me = member.guild.members.me;
            const removable = member.roles.cache.filter(r =>
                !r.managed && r.id !== member.guild.id && me && r.position < me.roles.highest.position
            );
            if (removable.size > 0) {
                await member.roles.remove(removable, reason);
            }
        }
    } catch (err) {
        console.error('[AntiNuke] Failed to apply punishment:', err);
    }

    if (an.autoLockdown) {
        await startLockdown(member.guild, member.client, {
            startedBy: member.client.user.id,
            reason: `Auto-lockdown after anti-nuke trigger by ${member.user.tag}`
        }).catch(err => console.error('[AntiNuke] Auto-lockdown failed:', err));
    }
}

async function trackAction(guild, action, auditType, targetId, client) {
    let settings;
    try {
        settings = await Guild.findOne({ guildId: guild.id });
    } catch (err) {
        console.error('[AntiNuke] DB fetch failed:', err);
        return;
    }
    if (!settings?.antiNuke?.enabled) return;

    const executor = await resolveExecutor(guild, auditType, targetId);
    if (!executor) return;
    if (isWhitelisted(executor, settings)) return;

    const an = settings.antiNuke;
    const windowMs = (an.windowSeconds || 30) * 1000;
    const threshold = an.thresholds?.[action];
    if (!threshold) return;

    const bucket = getActorBucket(guild.id, executor.id);
    const count = pruneAndPush(bucket, action, windowMs);

    if (count >= threshold) {
        bucket.set(action, []); // clear so we don't re-fire
        await punish(executor, settings, action, count);
    }
}

// --- Lockdown engine ---------------------------------------------------------

async function startLockdown(guild, client, { startedBy, reason }) {
    const settings = await Guild.findOne({ guildId: guild.id });
    if (!settings) return { ok: false, error: 'Guild not configured.' };
    if (settings.antiNuke?.lockdown?.active) {
        return { ok: false, error: 'Lockdown already active.' };
    }

    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { ok: false, error: 'Bot lacks Manage Channels permission.' };
    }

    const everyoneId = guild.id;
    const affected = [];

    const channels = guild.channels.cache.filter(c =>
        c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement ||
        c.type === ChannelType.GuildForum
    );

    for (const channel of channels.values()) {
        try {
            const existing = channel.permissionOverwrites.cache.get(everyoneId);
            const record = {
                channelId: channel.id,
                hadOverwrite: !!existing,
                previousAllow: existing ? existing.allow.bitfield.toString() : null,
                previousDeny:  existing ? existing.deny.bitfield.toString()  : null
            };
            await channel.permissionOverwrites.edit(everyoneId, {
                SendMessages: false,
                SendMessagesInThreads: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                AddReactions: false
            }, { reason: `[AntiNuke] Lockdown: ${reason || 'manual'}` });
            affected.push(record);
        } catch (err) {
            console.error(`[AntiNuke] Failed to lock channel ${channel.id}:`, err);
        }
    }

    await Guild.updateOne({ guildId: guild.id }, {
        $set: {
            'antiNuke.lockdown.active': true,
            'antiNuke.lockdown.startedAt': new Date(),
            'antiNuke.lockdown.startedBy': startedBy || null,
            'antiNuke.lockdown.reason': reason || null,
            'antiNuke.lockdown.affectedChannels': affected
        }
    });

    const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('SERVER LOCKDOWN')
        .setDescription(reason || 'Manual lockdown initiated.')
        .addFields({ name: 'Channels Locked', value: affected.length.toString(), inline: true })
        .setTimestamp();
    await alert(guild, settings, embed);

    return { ok: true, locked: affected.length };
}

async function endLockdown(guild, { endedBy } = {}) {
    const settings = await Guild.findOne({ guildId: guild.id });
    if (!settings) return { ok: false, error: 'Guild not configured.' };
    if (!settings.antiNuke?.lockdown?.active) {
        return { ok: false, error: 'No active lockdown.' };
    }

    const everyoneId = guild.id;
    const affected = settings.antiNuke.lockdown.affectedChannels || [];
    let restored = 0;

    for (const record of affected) {
        const channel = guild.channels.cache.get(record.channelId);
        if (!channel) continue;
        try {
            if (record.hadOverwrite) {
                // Reconstruct each lockdown key's original tri-state (allow / deny / inherit).
                const prevAllow = new PermissionsBitField(BigInt(record.previousAllow || '0'));
                const prevDeny  = new PermissionsBitField(BigInt(record.previousDeny  || '0'));
                const restoreOptions = {};
                for (const key of LOCKDOWN_KEYS) {
                    if (prevAllow.has(PermissionFlagsBits[key])) restoreOptions[key] = true;
                    else if (prevDeny.has(PermissionFlagsBits[key])) restoreOptions[key] = false;
                    else restoreOptions[key] = null;
                }
                await channel.permissionOverwrites.edit(everyoneId, restoreOptions, {
                    reason: '[AntiNuke] Lockdown ended'
                });
            } else {
                // Bot added the overwrite from scratch — delete it entirely.
                await channel.permissionOverwrites.delete(everyoneId, '[AntiNuke] Lockdown ended');
            }
            restored++;
        } catch (err) {
            console.error(`[AntiNuke] Failed to unlock channel ${record.channelId}:`, err);
        }
    }

    await Guild.updateOne({ guildId: guild.id }, {
        $set: {
            'antiNuke.lockdown.active': false,
            'antiNuke.lockdown.startedAt': null,
            'antiNuke.lockdown.startedBy': null,
            'antiNuke.lockdown.reason': null,
            'antiNuke.lockdown.affectedChannels': []
        }
    });

    const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('Lockdown Lifted')
        .addFields(
            { name: 'Channels Restored', value: restored.toString(), inline: true },
            { name: 'Ended By', value: endedBy ? `<@${endedBy}>` : 'system', inline: true }
        )
        .setTimestamp();
    await alert(guild, settings, embed);

    return { ok: true, restored };
}

// --- Join gate ---------------------------------------------------------------

async function enforceJoinGate(member) {
    if (member.user?.bot) return false;
    const settings = await Guild.findOne({ guildId: member.guild.id });
    const gate = settings?.antiNuke?.joinGate;
    if (!gate?.enabled) return false;

    const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    if (ageDays >= (gate.minAccountAgeDays || 0)) return false;

    const reason = `[AntiNuke] Join gate: account age ${ageDays.toFixed(1)}d < ${gate.minAccountAgeDays}d`;
    try {
        if (gate.action === 'ban' && member.bannable) {
            await member.ban({ reason, deleteMessageSeconds: 0 });
        } else if (member.kickable) {
            await member.kick(reason);
        }
    } catch (err) {
        console.error('[AntiNuke] Join-gate enforcement failed:', err);
        return false;
    }

    const embed = new EmbedBuilder()
        .setColor('#ff9900')
        .setTitle('Join Gate Triggered')
        .addFields(
            { name: 'User', value: `${member.user.tag} (${member.id})`, inline: false },
            { name: 'Account Age', value: `${ageDays.toFixed(1)} days`, inline: true },
            { name: 'Action', value: gate.action, inline: true }
        )
        .setTimestamp();
    await alert(member.guild, settings, embed);
    return true;
}

module.exports = {
    trackAction,
    startLockdown,
    endLockdown,
    enforceJoinGate,
    AuditLogEvent
};
