const User = require('../models/User');
const Guild = require('../models/Guild');

// Built-in quest definitions
const DAILY_QUESTS = [
    { questId: 'daily_messages_10', name: 'Chatty', description: 'Send 10 messages', target: 10 },
    { questId: 'daily_reactions_5', name: 'Reactor', description: 'React to 5 messages', target: 5 },
    { questId: 'daily_commands_3', name: 'Explorer', description: 'Use 3 bot commands', target: 3 }
];

const WEEKLY_QUESTS = [
    { questId: 'weekly_messages_50', name: 'Conversation Starter', description: 'Send 50 messages', target: 50 },
    { questId: 'weekly_streak_5', name: 'Consistent', description: 'Maintain a 5-day streak', target: 5 },
    { questId: 'weekly_commands_15', name: 'Bot Veteran', description: 'Use 15 bot commands', target: 15 }
];

function getDailyExpiry() {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    return d;
}

function getWeeklyExpiry() {
    const d = new Date();
    const daysUntilSunday = (7 - d.getUTCDay()) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysUntilSunday);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

function getAllQuestDefs() {
    return [
        ...DAILY_QUESTS.map(q => ({ ...q, type: 'daily', expiresAt: getDailyExpiry() })),
        ...WEEKLY_QUESTS.map(q => ({ ...q, type: 'weekly', expiresAt: getWeeklyExpiry() }))
    ];
}

// Ensure active quest entries exist for the user, pruning expired ones.
// NOTE: does not call user.save() — callers must persist after this.
async function ensureQuests(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return;

    const now = new Date();
    // Remove expired
    user.quests = (user.quests || []).filter(q => q.expiresAt > now);

    const existingIds = new Set(user.quests.map(q => q.questId));
    for (const def of getAllQuestDefs()) {
        if (!existingIds.has(def.questId)) {
            user.quests.push({ questId: def.questId, progress: 0, completedAt: null, expiresAt: def.expiresAt });
        }
    }
}

// Increment progress on a quest and return reward info if just completed
async function incrementQuest(user, questId, amount = 1) {
    const entry = user.quests?.find(q => q.questId === questId && !q.completedAt && q.expiresAt > new Date());
    if (!entry) return null;

    const def = getAllQuestDefs().find(d => d.questId === questId);
    if (!def) return null;

    entry.progress = Math.min((entry.progress || 0) + amount, def.target);

    if (entry.progress >= def.target) {
        entry.completedAt = new Date();
        return def;
    }
    return null;
}

// Award quest rewards (XP + coins + season XP) when a quest completes
async function awardQuest(user, questDef, guildSettings) {
    const isDaily = DAILY_QUESTS.some(d => d.questId === questDef.questId);
    const xp = isDaily
        ? (guildSettings?.quests?.dailyXpReward ?? 50)
        : (guildSettings?.quests?.weeklyXpReward ?? 300);
    const coins = isDaily
        ? (guildSettings?.quests?.dailyCoinReward ?? 25)
        : (guildSettings?.quests?.weeklyCoinReward ?? 150);

    user.xp += xp;
    user.balance += coins;
    await awardSeasonXp(user, xp, guildSettings);
    return { xp, coins };
}

// Season XP and tier-up logic
async function awardSeasonXp(user, xp, guildSettings) {
    const season = guildSettings?.season;
    if (!season?.enabled || !season.seasonId) return;
    if (user.season?.seasonId !== season.seasonId) {
        user.season = { seasonId: season.seasonId, xp: 0, tier: 0, claimedTiers: [] };
    }

    user.season.xp = (user.season.xp || 0) + xp;
    const xpPerTier = season.xpPerTier || 100;
    const maxTiers = season.maxTiers || 50;
    const newTier = Math.min(Math.floor(user.season.xp / xpPerTier), maxTiers);
    user.season.tier = newTier;
}

// Called from messageCreate when user sends a message
async function onMessage(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return [];
    const completed = [];

    const msg10 = await incrementQuest(user, 'daily_messages_10');
    if (msg10) completed.push(await awardQuest(user, msg10, guildSettings));

    const wk50 = await incrementQuest(user, 'weekly_messages_50');
    if (wk50) completed.push(await awardQuest(user, wk50, guildSettings));

    return completed;
}

// Called from messageReactionAdd when user adds a reaction
async function onReaction(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return [];
    const completed = [];

    const react5 = await incrementQuest(user, 'daily_reactions_5');
    if (react5) completed.push(await awardQuest(user, react5, guildSettings));

    return completed;
}

// Called from interactionCreate when user uses a command
async function onCommandUse(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return [];
    const completed = [];

    const cmd3 = await incrementQuest(user, 'daily_commands_3');
    if (cmd3) completed.push(await awardQuest(user, cmd3, guildSettings));

    const wkCmd15 = await incrementQuest(user, 'weekly_commands_15');
    if (wkCmd15) completed.push(await awardQuest(user, wkCmd15, guildSettings));

    return completed;
}

// Called from streak updates in messageCreate
async function onStreakUpdate(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return [];
    const streak = user.streak?.current || 0;
    const completed = [];

    if (streak >= 5) {
        const entry = user.quests?.find(q => q.questId === 'weekly_streak_5' && !q.completedAt && q.expiresAt > new Date());
        if (entry) {
            const def = getAllQuestDefs().find(d => d.questId === 'weekly_streak_5');
            if (def && entry.progress < def.target) {
                entry.progress = def.target;
                entry.completedAt = new Date();
                completed.push(await awardQuest(user, def, guildSettings));
            }
        }
    }

    return completed;
}

function getQuestDefs() {
    return getAllQuestDefs();
}

function startQuestService() {
    // Placeholder: quest expiry/reset is handled per-user via ensureQuests on each interaction
    console.log('[QUESTS] Quest service ready (per-user lazy expiry)');
}

module.exports = { ensureQuests, onMessage, onReaction, onCommandUse, onStreakUpdate, getQuestDefs, awardSeasonXp, startQuestService };
