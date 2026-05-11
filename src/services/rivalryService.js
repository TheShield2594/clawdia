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
        const cached = await getLeaderboard(guild.id);

        // Capture old rank from the unmodified snapshot
        const oldIdx = cached.findIndex(e => e.userId === savedUser.userId);
        const oldRank = oldIdx === -1 ? null : oldIdx + 1;

        // Build a new sorted array — never mutate the cached reference so
        // concurrent calls always see a consistent snapshot
        const updated = cached.map(e =>
            e.userId === savedUser.userId
                ? { userId: savedUser.userId, level: savedUser.level, xp: savedUser.xp }
                : e
        );
        if (oldIdx === -1) {
            updated.push({ userId: savedUser.userId, level: savedUser.level, xp: savedUser.xp });
        }
        updated.sort((a, b) => b.level - a.level || b.xp - a.xp);

        // Replace the cache entry atomically with the fully-built array
        rankCache.set(guild.id, { entries: updated, updatedAt: Date.now() });

        const newIdx = updated.findIndex(e => e.userId === savedUser.userId);
        const newRank = newIdx + 1;

        if (newRank > MAX_RANK) return;
        if (!oldRank || newRank >= oldRank) return;

        // Number of positions gained — used to derive the overtaken slice
        const climbCount = oldRank - newRank;
        const now = Date.now();

        const climberDiscord = await client.users.fetch(savedUser.userId).catch(() => null);
        const climberTag = climberDiscord?.tag || 'Someone';

        // After sorting, overtaken users occupy the climbCount slots directly
        // below the climber's new position
        const overtakenSlice = updated.slice(newIdx + 1, newIdx + 1 + climbCount);
        for (const entry of overtakenSlice) {
            const overtakenRank = updated.findIndex(e => e.userId === entry.userId) + 1;
            if (overtakenRank - newRank > MAX_RANK_DIFF) continue;

            const overtakenDoc = await User.findOne(
                { userId: entry.userId, guildId: guild.id },
                { 'notifications.leaderboard.overtaken': 1, 'leaderboard.lastOvertakenNotification': 1 }
            ).lean();
            if (!overtakenDoc) continue;

            const overtakenAllowed = overtakenDoc.notifications?.leaderboard?.overtaken ?? true;
            if (!overtakenAllowed) continue;

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

        const climbedEnabled = selfDoc?.notifications?.leaderboard?.climbed ?? false;
        if (!climbedEnabled) return;

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
