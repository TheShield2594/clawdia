const User = require('../models/User');

// guildId -> { entries: [{userId, level, xp}], index: Map(userId -> position), updatedAt, truncated }
const rankCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_RANK = 100;             // only notify users within top 100
const MAX_RANK_DIFF = 10;         // only notify when rival is within 10 ranks

// Both bounds exist so the cache has a memory ceiling instead of growing with
// every guild and member the bot ever sees. Rivalry only cares about the top
// MAX_RANK, so a window of double that loses nothing the feature reads; a
// guild beyond MAX_GUILDS evicts the oldest cached guild FIFO (same pattern as
// utils/boundedRateLimiter), which merely costs that guild one re-read.
const MAX_GUILDS = 500;
const MAX_ENTRIES_PER_GUILD = 200;
const NOTIFY_COOLDOWN = 60 * 60 * 1000; // 1 notification per user per hour

// Significant rank thresholds that trigger the optional "climbed" DM
const CLIMB_THRESHOLDS = [10, 50, 100];

/** The leaderboard order: level first, XP as the tiebreak — the `find` sort below. */
function compare(a, b) {
    return b.level - a.level || b.xp - a.xp;
}

function buildIndex(entries) {
    const index = new Map();
    for (let i = 0; i < entries.length; i++) index.set(entries[i].userId, i);
    return index;
}

async function getLeaderboard(guildId) {
    const cached = rankCache.get(guildId);
    if (cached && Date.now() - cached.updatedAt < CACHE_TTL) {
        return cached;
    }
    const users = await User.find({ guildId })
        .sort({ level: -1, xp: -1 })
        .limit(MAX_ENTRIES_PER_GUILD)
        .select('userId level xp')
        .lean();
    const entry = {
        entries: users,
        index: buildIndex(users),
        updatedAt: Date.now(),
        // A full window means the guild (probably) has more members than the
        // cache holds, so anyone not in the index has an unknown rank below it.
        truncated: users.length === MAX_ENTRIES_PER_GUILD,
    };
    if (!rankCache.has(guildId) && rankCache.size >= MAX_GUILDS) {
        rankCache.delete(rankCache.keys().next().value);
    }
    rankCache.set(guildId, entry);
    return entry;
}

/**
 * Moves the entry at `from` to the position its new level/XP earns, shifting the
 * entries it passes by one and keeping the index in step.
 *
 * The array is already sorted apart from this one entry, so the move only ever
 * touches the span between the old and new positions — an XP gain shifts a
 * player past the handful of people they actually overtook, not past everyone.
 * That is the whole point: this runs on every XP-earning message, and the sort
 * it replaces rebuilt and re-ordered the entire guild each time (14 ms at 50k
 * members, synchronously, on the event loop).
 *
 * Returns the entry's new position.
 */
function reposition(entries, index, from) {
    const moved = entries[from];
    let i = from;

    while (i > 0 && compare(moved, entries[i - 1]) < 0) {
        entries[i] = entries[i - 1];
        index.set(entries[i].userId, i);
        i--;
    }
    if (i === from) {
        while (i < entries.length - 1 && compare(moved, entries[i + 1]) > 0) {
            entries[i] = entries[i + 1];
            index.set(entries[i].userId, i);
            i++;
        }
    }

    entries[i] = moved;
    index.set(moved.userId, i);
    return i;
}

/**
 * Folds a saved user's new level/XP into the cached leaderboard.
 *
 * The update happens in place rather than on a copy. Nothing here awaits, so no
 * concurrent caller can observe a half-shifted array — and a caller that is
 * suspended mid-notification wants the current standings anyway, not the ones
 * from before its own await.
 *
 * Returns `{ oldRank, newRank, overtaken }`, where `overtaken` lists the players
 * this user passed together with the rank each of them now holds — or null when
 * the board is a truncated window and this user falls outside it, in which case
 * nothing changed and the caller has nothing to notify about.
 *
 * Deliberately does NOT touch board.updatedAt: bumping it on every write-through
 * turned the TTL into "5 minutes since the last message", which on any active
 * guild is never — the entry could not expire, so a board that drifted (or a
 * guild that shrank) was never re-read. The write-through keeps the board
 * current between refreshes; the TTL now actually fires and replaces it.
 */
function applyStanding(board, savedUser) {
    const { entries, index } = board;
    const oldIdx = index.get(savedUser.userId) ?? -1;

    // On a truncated board an unknown user's real rank is somewhere below the
    // window. If they still sort at-or-below the current last entry, placing
    // them would invent a rank; they are also nowhere near MAX_RANK, so skip.
    // A user who now sorts above the last entry has climbed into the window
    // and is inserted (the entry that falls off the end is trimmed below).
    if (oldIdx === -1 && board.truncated) {
        const last = entries[entries.length - 1];
        if (last && compare(savedUser, last) >= 0) return null;
    }

    let from;
    if (oldIdx === -1) {
        from = entries.length;
        entries.push({ userId: savedUser.userId, level: savedUser.level, xp: savedUser.xp });
        index.set(savedUser.userId, from);
    } else {
        from = oldIdx;
        entries[from].level = savedUser.level;
        entries[from].xp    = savedUser.xp;
    }

    const newIdx = reposition(entries, index, from);

    // Everyone between the new and old positions was shifted down by exactly
    // one, so their ranks are known without searching for them again.
    const overtaken = [];
    for (let i = newIdx + 1; i <= from; i++) {
        overtaken.push({ userId: entries[i].userId, rank: i + 1 });
    }

    // An insertion into a truncated window pushed one entry past the cap.
    if (board.truncated && entries.length > MAX_ENTRIES_PER_GUILD) {
        const dropped = entries.pop();
        index.delete(dropped.userId);
    }

    return {
        oldRank: oldIdx === -1 ? null : oldIdx + 1,
        newRank: newIdx + 1,
        overtaken,
    };
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
        const board = await getLeaderboard(guild.id);
        const standing = applyStanding(board, savedUser);
        if (!standing) return; // outside a truncated board's window — nothing to report
        const { oldRank, newRank, overtaken } = standing;

        if (newRank > MAX_RANK) return;
        if (!oldRank || newRank >= oldRank) return;

        const now = Date.now();

        const climberDiscord = await client.users.fetch(savedUser.userId).catch(() => null);
        const climberTag = climberDiscord?.tag || 'Someone';

        for (const passed of overtaken) {
            if (passed.rank - newRank > MAX_RANK_DIFF) continue;

            const overtakenDoc = await User.findOne(
                { userId: passed.userId, guildId: guild.id },
                { 'notifications.leaderboard.overtaken': 1, 'leaderboard.lastOvertakenNotification': 1 }
            ).lean();
            if (!overtakenDoc) continue;

            const overtakenAllowed = overtakenDoc.notifications?.leaderboard?.overtaken ?? true;
            if (!overtakenAllowed) continue;

            const lastNotif = overtakenDoc.leaderboard?.lastOvertakenNotification;
            if (lastNotif && now - new Date(lastNotif).getTime() < NOTIFY_COOLDOWN) continue;

            const target = await client.users.fetch(passed.userId).catch(() => null);
            if (!target) continue;

            await target.send(
                `📉 **${climberTag}** just passed you on the **${guild.name}** leaderboard! ` +
                `They're now rank **#${newRank}** and you're **#${passed.rank}**. Time to catch up!`
            ).catch(() => {});

            await User.updateOne(
                { userId: passed.userId, guildId: guild.id },
                { $set: { 'leaderboard.lastOvertakenNotification': new Date() } }
            ).catch(err => console.error('[rivalry] lastOvertakenNotification update failed:', err.message));
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
            ).catch(err => console.error('[rivalry] lastClimbedNotification update failed:', err.message));
        }
    } catch (err) {
        console.error('Rivalry check error:', err);
    }
}

module.exports = {
    checkRivalry,
    __test__: {
        applyStanding, reposition, compare, buildIndex, rankCache, getLeaderboard,
        CACHE_TTL, MAX_GUILDS, MAX_ENTRIES_PER_GUILD,
    },
};
