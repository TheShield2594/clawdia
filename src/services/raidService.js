const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const { assertGuildAffinity } = require('../utils/sharding');
const COLORS = require('../utils/embedColors');
const { handlesGuild } = require('../utils/sharding');

// guildId -> [{timestamp, userId, accountAgeDays}]
//
// In-memory only: data is lost on restart and not shared across processes. This
// one is a sliding window of recent joins used to detect a raid, and it moves no
// money — the cost of losing it is a raid burst that has to re-establish its
// rate before tripping the detector, and the cost of two processes is each
// seeing roughly half the joins. Raid mode itself is persisted on the Guild
// document (the Set below is a read cache of that field), so the state that
// changes how the server behaves does survive both.
//
// For multi-shard or high-availability deployments, replace with a Redis-backed
// store using sorted sets (ZADD/ZRANGEBYSCORE with TTL) for atomic, shared state.
const joinLog = new Map();

/**
 * Guild ids currently in raid mode — an in-memory mirror of
 * `raidDetection.raidModeActive` on the Guild document, exported so callers can
 * ask without a database round trip. The document is the source of truth.
 * @type {Set<string>}
 */
const raidModeActive = new Set();
/**
 * How each active raid mode was turned on: `'auto'` by the join-rate detector,
 * `'manual'` by a moderator. Only `'auto'` is swept off again.
 * @type {Map<string, 'auto'|'manual'>}
 */
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

/**
 * `settings` is the caller's already-resolved guild settings, passed down by
 * guildMemberAdd so one join costs one settings read rather than three (#593).
 * Omit it and this reads for itself.
 */
/**
 * Record a join in the guild's sliding window and, if the window is now over
 * threshold, turn raid mode on and act on the joiner.
 *
 * Called from the `guildMemberAdd` event for every join, so the cheap exits
 * come first: a guild with raid detection disabled costs one settings read, or
 * none when the caller already has them.
 *
 * Only accounts younger than `minAccountAgeDays` are kicked or quarantined —
 * raid mode being on does not by itself act on an established member.
 *
 * @param {import('discord.js').GuildMember} member the member who joined
 * @param {import('discord.js').Client} _client unused; the signature is the
 *   event handler's
 * @param {object} [settings] the guild's settings, when the caller has already
 *   read them. Omit and they are fetched; a read failure is logged and the join
 *   is ignored rather than throwing into the event handler
 * @returns {Promise<void>}
 */
async function handleMemberJoin(member, _client, settings) {
    const guildId = member.guild.id;

    let guildSettings = settings;
    if (guildSettings === undefined) {
        try {
            guildSettings = await Guild.findOne({ guildId });
        } catch (err) {
            console.error(`[RaidService] DB error fetching guild ${guildId}:`, err);
            return;
        }
    }

    if (!guildSettings?.raidDetection?.enabled) return;

    const rd = guildSettings.raidDetection;
    const windowMs = (rd.windowSeconds || 60) * 1000;
    const threshold = rd.threshold || 10;
    const minAccountAgeDays = rd.minAccountAgeDays || 7;

    const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000;

    // The window is a per-guild sliding count, so it is only a true count while
    // one shard sees all of that guild's joins — which Discord's routing
    // guarantees. See src/utils/sharding.js (#732); two shards each seeing half
    // the joins is precisely a detector that needs double the real rate to trip.
    assertGuildAffinity(guildId, 'raid join window');
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
        .setColor(COLORS.ERROR)
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

    // Set in-memory state before the first await so concurrent joins can't
    // both pass the raidModeActive.has() guard and double-trigger the alert.
    raidModeActive.add(guildId);
    raidModeActivatedBy.set(guildId, 'auto');

    if (alertChannel) {
        await alertChannel.send({ embeds: [embed] }).catch(console.error);
    }

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

/**
 * Turn raid mode on or off by hand, from `/raidmode toggle`.
 *
 * Writes both the in-memory mirror and the Guild document, and announces the
 * change in the raid alert channel (or the moderation log, if no raid channel
 * is set). A mode set this way is marked `manual`, which is what stops
 * `sweepRaidModes` from turning it off again when the server goes quiet — a
 * moderator's decision outlasts the calm window.
 *
 * @param {string} guildId
 * @param {import('discord.js').Guild} guild for resolving the alert channel
 * @param {boolean} active on or off
 * @param {object} guildSettings the guild's settings, already read
 * @returns {Promise<void>}
 */
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
                .setColor(COLORS.WARN)
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
                .setColor(COLORS.SUCCESS)
                .setTitle('🔓 Raid Mode Manually Disabled')
                .setDescription('Raid mode has been manually disabled by a moderator.')
                .setTimestamp();
            await alertChannel.send({ embeds: [embed] }).catch(console.error);
        }
    }
}

/**
 * Periodic tick: auto-disable raid mode in every guild that has gone quiet for
 * its calm window. Guilds whose raid mode was set manually are skipped.
 *
 * Registered in services/scheduler as a job rather than owning a `setInterval`
 * here (#611). The interval ran outside `runJob`, so a throw inside it recorded
 * nothing: no dead-letter entry, no failed run on the health payload, and
 * /health went on reporting healthy while raid mode never auto-disabled again.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function sweepRaidModes(client) {
    if (raidModeActive.size === 0) return;

    for (const guildId of [...raidModeActive]) {
        // Per-guild job. `raidModeActive` is process-local and only ever filled
        // by join events, which reach the owning shard — so this guard is
        // normally redundant. It is here for the case it is not: a guild whose
        // routing changed under a reshard would otherwise have its raid mode
        // disabled by a process that cannot see whether the raid is still going.
        if (!handlesGuild(guildId, client)) continue;

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

        // Persist before forgetting. The other order leaves memory saying raid
        // mode is off while the database still says it is on, and a restart
        // then reloads a raid mode nothing will lift. A throw here propagates
        // to runJob rather than being logged and swallowed: that is the whole
        // point of running this as a job, and the next tick is a minute away.
        await Guild.updateOne({ guildId }, {
            $set: {
                'raidDetection.raidModeActive': false,
                'raidDetection.raidModeActivatedBy': null,
                'raidDetection.raidModeActivatedAt': null
            }
        });

        raidModeActive.delete(guildId);
        raidModeActivatedBy.delete(guildId);

        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        const alertChannelId = rd.alertChannelId || guildSettings.moderation?.logChannelId;
        const alertChannel = alertChannelId ? guild.channels.cache.get(alertChannelId) : null;

        if (alertChannel) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('✅ Raid Stopped — Raid Mode Auto-Disabled')
                .setDescription('Raid appears to have stopped. Raid mode auto-disabled.')
                .setTimestamp();
            await alertChannel.send({ embeds: [embed] }).catch(console.error);
        }
    }
}

module.exports = { handleMemberJoin, sweepRaidModes, setRaidMode, raidModeActive, raidModeActivatedBy };
