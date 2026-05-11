const User = require('../models/User');

// guildId -> { entries: [{userId, level, xp}], updatedAt }
const rankCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_RANK = 100;             // only notify users within top 100
const MAX_RANK_DIFF = 10;         // only notify when rival is within 10 ranks
const NOTIFY_COOLDOWN = 60 * 60 * 1000; // 1 notification per user per hour

// Significant rank thresholds that trigger the optional "climbed" DM
const CLIMB_THRESHOLDS = [10, 50, 100];

async function getLeaderboard(guildId) {
    const cached = rankCache.get(guildId);
    if (cached && Date.now() - cached.updatedAt < CACHE_TTL) {
        return cached.entries;
    }
    const users = await User.find({ guildId })
        .sort({ level: -1, xp: -1 })
        .select('userId level xp')
        .lean();
    rankCache.set(guildId, { entries: users, updatedAt: Date.now() });
    return users;
}

/**
 * Called after a user's XP/level is saved. Checks whether they overtook any
 * rivals and sends rivalry DMs as appropriate, then updates the rank cache.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild}  guild
 * @param {{ userId: string, level: number, xp: number }} savedUser
 */
async function checkRivalry(client, guild, savedUser) {
    try {
        const entries = await getLeaderboard(guild.id);

        // Find old rank in the cached list
        const oldIdx = entries.findIndex(e => e.userId === savedUser.userId);
        const oldRank = oldIdx === -1 ? null : oldIdx + 1;

        // Update (or insert) this user's entry in the cache and re-sort
        if (oldIdx !== -1) {
            entries[oldIdx] = { userId: savedUser.userId, level: savedUser.level, xp: savedUser.xp };
        } else {
            entries.push({ userId: savedUser.userId, level: savedUser.level, xp: savedUser.xp });
        }
        entries.sort((a, b) => b.level - a.level || b.xp - a.xp);

        const newIdx = entries.findIndex(e => e.userId === savedUser.userId);
        const newRank = newIdx + 1;

        // Only care about top 100
        if (newRank > MAX_RANK) return;

        // User must have actually climbed
        if (!oldRank || newRank >= oldRank) return;

        const now = Date.now();

        // Fetch the climber's Discord user once for DM content
        const climberDiscord = await client.users.fetch(savedUser.userId).catch(() => null);
        const climberTag = climberDiscord?.tag || 'Someone';

        // Notify each overtaken user (slice between newIdx+1 and oldIdx, exclusive)
        const overtakenSlice = entries.slice(newIdx + 1, oldIdx);
        for (const entry of overtakenSlice) {
            const overtakenIdx = entries.findIndex(e => e.userId === entry.userId);
            const overtakenRank = overtakenIdx + 1;

            if (overtakenRank - newRank > MAX_RANK_DIFF) continue;

            // Fetch preferences + anti-spam timestamp with a targeted projection
            const overtakenDoc = await User.findOne(
                { userId: entry.userId, guildId: guild.id },
                { 'notifications.leaderboard.overtaken': 1, 'leaderboard.lastOvertakenNotification': 1 }
            ).lean();
            if (!overtakenDoc) continue;
            if (overtakenDoc.notifications?.leaderboard?.overtaken === false) continue;

            const lastNotif = overtakenDoc.leaderboard?.lastOvertakenNotification;
            if (lastNotif && now - new Date(lastNotif).getTime() < NOTIFY_COOLDOWN) continue;

            const target = await client.users.fetch(entry.userId).catch(() => null);
            if (!target) continue;

            await target.send(
                `📉 **${climberTag}** just passed you on the **${guild.name}** leaderboard! ` +
                `They're now rank **#${newRank}** and you're **#${overtakenRank}**. Time to catch up!`
            ).catch(() => {});

            await User.updateOne(
                { userId: entry.userId, guildId: guild.id },
                { $set: { 'leaderboard.lastOvertakenNotification': new Date() } }
            ).catch(() => {});
        }

        // Optional "climbed" DM — only on significant threshold crossings
        const crossedThreshold = CLIMB_THRESHOLDS.find(t => newRank <= t && (!oldRank || oldRank > t));
        if (!crossedThreshold) return;

        const selfDoc = await User.findOne(
            { userId: savedUser.userId, guildId: guild.id },
            { 'notifications.leaderboard.climbed': 1, 'leaderboard.lastClimbedNotification': 1 }
        ).lean();
        if (!selfDoc?.notifications?.leaderboard?.climbed) return;

        const lastClimb = selfDoc.leaderboard?.lastClimbedNotification;
        if (lastClimb && now - new Date(lastClimb).getTime() < NOTIFY_COOLDOWN) return;

        if (climberDiscord) {
            await climberDiscord.send(
                `📈 You've moved up to rank **#${newRank}** on the **${guild.name}** leaderboard!`
            ).catch(() => {});
            await User.updateOne(
                { userId: savedUser.userId, guildId: guild.id },
                { $set: { 'leaderboard.lastClimbedNotification': new Date() } }
            ).catch(() => {});
        }
    } catch (err) {
        console.error('Rivalry check error:', err);
    }
}

module.exports = { checkRivalry };
