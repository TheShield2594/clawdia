const User = require('../models/User');
const Guild = require('../models/Guild');
const { getStreakMultiplier } = require('../utils/streakMultiplier');

// difficulty → reward multiplier
const DIFFICULTY_MULTIPLIERS = { easy: 1, medium: 1.75, hard: 3 };

const DAILY_QUEST_POOL = [
    // Easy
    { questId: 'daily_messages_5',      name: 'Icebreaker',        description: 'Send 5 messages',                   target: 5,   difficulty: 'easy',   category: 'social'   },
    { questId: 'daily_reactions_3',     name: 'Hype Train',        description: 'React to 3 messages',               target: 3,   difficulty: 'easy',   category: 'social'   },
    { questId: 'daily_commands_2',      name: 'First Steps',       description: 'Use 2 bot commands',                target: 2,   difficulty: 'easy',   category: 'explore'  },
    { questId: 'daily_messages_10',     name: 'Chatty',            description: 'Send 10 messages',                  target: 10,  difficulty: 'easy',   category: 'social'   },
    { questId: 'daily_reactions_5',     name: 'Reactor',           description: 'React to 5 messages',               target: 5,   difficulty: 'easy',   category: 'social'   },

    // Medium
    { questId: 'daily_commands_5',      name: 'Explorer',          description: 'Use 5 bot commands',                target: 5,   difficulty: 'medium', category: 'explore'  },
    { questId: 'daily_messages_25',     name: 'Conversationalist', description: 'Send 25 messages',                  target: 25,  difficulty: 'medium', category: 'social'   },
    { questId: 'daily_reactions_10',    name: 'Emote Master',      description: 'React to 10 messages',              target: 10,  difficulty: 'medium', category: 'social'   },
    { questId: 'daily_economy_earn_50', name: 'Coin Collector',    description: 'Earn 50 coins through activities',  target: 50,  difficulty: 'medium', category: 'economy'  },
    { questId: 'daily_hunt_1',          name: 'First Hunt',        description: 'Complete 1 hunt',                   target: 1,   difficulty: 'medium', category: 'hunt'     },
    { questId: 'daily_fish_1',          name: 'Gone Fishin\'',     description: 'Make 1 fishing cast',               target: 1,   difficulty: 'medium', category: 'fishing'  },

    // Hard
    { questId: 'daily_messages_50',     name: 'Non-stop',          description: 'Send 50 messages',                  target: 50,  difficulty: 'hard',   category: 'social'   },
    { questId: 'daily_commands_10',     name: 'Bot Addict',        description: 'Use 10 bot commands',               target: 10,  difficulty: 'hard',   category: 'explore'  },
    { questId: 'daily_economy_earn_200','name': 'Money Grubber',   description: 'Earn 200 coins through activities', target: 200, difficulty: 'hard',   category: 'economy'  },
    { questId: 'daily_hunt_5',          name: 'Hunt Frenzy',       description: 'Complete 5 hunts',                  target: 5,   difficulty: 'hard',   category: 'hunt'     },
    { questId: 'daily_fish_5',          name: 'Cast Away',         description: 'Make 5 fishing casts',              target: 5,   difficulty: 'hard',   category: 'fishing'  },
    { questId: 'daily_reactions_20',    name: 'Reaction God',      description: 'React to 20 messages',              target: 20,  difficulty: 'hard',   category: 'social'   },
];

const WEEKLY_QUEST_POOL = [
    // Easy
    { questId: 'weekly_messages_50',    name: 'Conversation Starter', description: 'Send 50 messages this week',          target: 50,  difficulty: 'easy',   category: 'social'   },
    { questId: 'weekly_commands_10',    name: 'Regular',              description: 'Use 10 bot commands this week',        target: 10,  difficulty: 'easy',   category: 'explore'  },

    // Medium
    { questId: 'weekly_messages_150',   name: 'Motormouth',           description: 'Send 150 messages this week',          target: 150, difficulty: 'medium', category: 'social'   },
    { questId: 'weekly_streak_3',       name: 'Getting into It',      description: 'Maintain a 3-day activity streak',      target: 3,   difficulty: 'medium', category: 'streak'   },
    { questId: 'weekly_commands_25',    name: 'Bot Veteran',          description: 'Use 25 bot commands this week',         target: 25,  difficulty: 'medium', category: 'explore'  },
    { questId: 'weekly_economy_500',    name: 'Hustler',              description: 'Earn 500 coins this week',              target: 500, difficulty: 'medium', category: 'economy'  },
    { questId: 'weekly_hunt_10',        name: 'Dedicated Hunter',     description: 'Complete 10 hunts this week',           target: 10,  difficulty: 'medium', category: 'hunt'     },
    { questId: 'weekly_fish_10',        name: 'Weekend Angler',       description: 'Make 10 fishing casts this week',       target: 10,  difficulty: 'medium', category: 'fishing'  },

    // Hard
    { questId: 'weekly_streak_5',       name: 'Consistent',           description: 'Maintain a 5-day activity streak',      target: 5,   difficulty: 'hard',   category: 'streak'   },
    { questId: 'weekly_messages_300',   name: 'Chatterbox',           description: 'Send 300 messages this week',           target: 300, difficulty: 'hard',   category: 'social'   },
    { questId: 'weekly_economy_1500',   name: 'High Roller',          description: 'Earn 1500 coins this week',             target: 1500,difficulty: 'hard',   category: 'economy'  },
    { questId: 'weekly_hunt_25',        name: 'Trophy Collector',     description: 'Complete 25 hunts this week',           target: 25,  difficulty: 'hard',   category: 'hunt'     },
    { questId: 'weekly_fish_25',        name: 'Master Angler',        description: 'Make 25 fishing casts this week',       target: 25,  difficulty: 'hard',   category: 'fishing'  },
];

const CATEGORY_EMOJIS = {
    social:  '💬',
    explore: '🔍',
    economy: '💰',
    hunt:    '🏹',
    fishing: '🎣',
    streak:  '🔥',
};

const DIFFICULTY_COLORS = { easy: '🟢', medium: '🟡', hard: '🔴' };

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

// Weighted random selection: higher-level users are more likely to get harder quests.
function pickWeighted(pool, count, userLevel) {
    const lvl = userLevel || 1;
    const entries = [];
    for (const q of pool) {
        let weight;
        if (q.difficulty === 'easy')        weight = lvl < 10 ? 4 : lvl < 30 ? 2 : 1;
        else if (q.difficulty === 'medium') weight = lvl < 5  ? 1 : lvl < 20 ? 2 : 3;
        else                                weight = lvl < 10 ? 1 : lvl < 30 ? 2 : 4; // hard
        for (let i = 0; i < weight; i++) entries.push(q);
    }
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    const seen = new Set();
    const result = [];
    for (const q of shuffled) {
        if (!seen.has(q.questId)) {
            seen.add(q.questId);
            result.push(q);
            if (result.length >= count) break;
        }
    }
    // Fallback: pad with remaining quests if pool was too small after weighting
    if (result.length < count) {
        const remaining = pool.filter(q => !seen.has(q.questId)).sort(() => Math.random() - 0.5);
        result.push(...remaining.slice(0, count - result.length));
    }
    return result;
}

// Assign a fresh daily/weekly quest set for a user, keeping any still-active ones.
// Does NOT call user.save() — callers must persist.
// Returns { assignedNewDaily: boolean } so callers can send a reset notification.
async function ensureQuests(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { assignedNewDaily: false };

    const now = new Date();
    user.quests = (user.quests || []).filter(q => q.expiresAt > now);

    const dailyCount  = guildSettings.quests.questsPerDay  ?? 3;
    const weeklyCount = guildSettings.quests.questsPerWeek ?? 2;
    const userLevel   = user.level || 1;

    const activeIds = new Set(user.quests.map(q => q.questId));

    const dailyExpiry  = getDailyExpiry();
    const weeklyExpiry = getWeeklyExpiry();

    // Mutually exclusive by type: daily expires before the weekly cutoff, weekly at or after.
    // Using getTime() avoids the Saturday edge case where dailyExpiry === weeklyExpiry.
    const dailyExpiryMs  = dailyExpiry.getTime();
    const weeklyExpiryMs = weeklyExpiry.getTime();
    const activeDailyIds  = user.quests.filter(q => { const t = q.expiresAt.getTime(); return t === dailyExpiryMs && t < weeklyExpiryMs; }).map(q => q.questId);
    const activeWeeklyIds = user.quests.filter(q => q.expiresAt.getTime() >= weeklyExpiryMs).map(q => q.questId);

    const dailyNeeded  = dailyCount  - activeDailyIds.length;
    const weeklyNeeded = weeklyCount - activeWeeklyIds.length;

    let assignedNewDaily = false;

    if (dailyNeeded > 0) {
        const available = DAILY_QUEST_POOL.filter(q => !activeIds.has(q.questId));
        const picked = pickWeighted(available, dailyNeeded, userLevel);
        for (const def of picked) {
            user.quests.push({ questId: def.questId, progress: 0, completedAt: null, expiresAt: dailyExpiry });
            activeIds.add(def.questId);
        }
        if (picked.length > 0) assignedNewDaily = true;
    }

    if (weeklyNeeded > 0) {
        const available = WEEKLY_QUEST_POOL.filter(q => !activeIds.has(q.questId));
        const picked = pickWeighted(available, weeklyNeeded, userLevel);
        for (const def of picked) {
            user.quests.push({ questId: def.questId, progress: 0, completedAt: null, expiresAt: weeklyExpiry });
        }
    }

    return { assignedNewDaily };
}

function getDefById(questId) {
    return DAILY_QUEST_POOL.find(d => d.questId === questId)
        || WEEKLY_QUEST_POOL.find(d => d.questId === questId)
        || null;
}

// Increment progress on an active quest.
// Returns { completed: def|null, nearComplete: def|null }.
// nearComplete fires once when progress first crosses 80% without completing.
async function incrementQuest(user, questId, amount = 1) {
    const entry = user.quests?.find(q => q.questId === questId && !q.completedAt && q.expiresAt > new Date());
    if (!entry) return { completed: null, nearComplete: null };

    const def = getDefById(questId);
    if (!def) return { completed: null, nearComplete: null };

    const prevProgress = entry.progress || 0;
    entry.progress = Math.min(prevProgress + amount, def.target);

    if (entry.progress >= def.target) {
        entry.completedAt = new Date();
        return { completed: def, nearComplete: null };
    }

    // Fire near-complete exactly once: when crossing the 80% threshold
    const threshold = Math.ceil(def.target * 0.8);
    if (entry.progress >= threshold && prevProgress < threshold) {
        return { completed: null, nearComplete: def };
    }

    return { completed: null, nearComplete: null };
}

// Award XP + coins scaled by difficulty; returns { xp, coins, def }
async function awardQuest(user, questDef, guildSettings) {
    const isDaily = DAILY_QUEST_POOL.some(d => d.questId === questDef.questId);
    const mult = DIFFICULTY_MULTIPLIERS[questDef.difficulty] ?? 1;
    const streakMult = getStreakMultiplier(user.streak?.current ?? 0);

    const baseXp    = isDaily ? (guildSettings?.quests?.dailyXpReward    ?? 50)  : (guildSettings?.quests?.weeklyXpReward    ?? 300);
    const baseCoins = isDaily ? (guildSettings?.quests?.dailyCoinReward   ?? 25)  : (guildSettings?.quests?.weeklyCoinReward  ?? 150);

    const xp    = Math.round(baseXp    * mult * streakMult);
    const coins = Math.round(baseCoins * mult * streakMult);

    user.xp      += xp;
    user.balance += coins;
    user.questsCompleted = (user.questsCompleted || 0) + 1;
    await awardSeasonXp(user, xp, guildSettings);
    return { xp, coins, def: questDef };
}

async function awardSeasonXp(user, xp, guildSettings) {
    const season = guildSettings?.season;
    if (!season?.enabled || !season.seasonId) return;
    if (user.season?.seasonId !== season.seasonId) {
        user.season = { seasonId: season.seasonId, xp: 0, tier: 0, claimedTiers: [] };
    }
    user.season.xp = (user.season.xp || 0) + xp;
    const xpPerTier = season.xpPerTier || 100;
    const maxTiers  = season.maxTiers  || 50;
    user.season.tier = Math.min(Math.floor(user.season.xp / xpPerTier), maxTiers);
}

// ── Event hooks ──────────────────────────────────────────────────────────────

async function onMessage(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_messages_5', 'daily_messages_10', 'daily_messages_25', 'daily_messages_50',
                           'weekly_messages_50', 'weekly_messages_150', 'weekly_messages_300']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onReaction(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_reactions_3', 'daily_reactions_5', 'daily_reactions_10', 'daily_reactions_20']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onCommandUse(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_commands_2', 'daily_commands_5', 'daily_commands_10',
                           'weekly_commands_10', 'weekly_commands_25']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onEconomyEarn(user, guildSettings, amount) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_economy_earn_50', 'daily_economy_earn_200',
                           'weekly_economy_500', 'weekly_economy_1500']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId, amount);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onHunt(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_hunt_1', 'daily_hunt_5', 'weekly_hunt_10', 'weekly_hunt_25']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onFish(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_fish_1', 'daily_fish_5', 'weekly_fish_10', 'weekly_fish_25']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onStreakUpdate(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const streak    = user.streak?.current || 0;
    const completed = [];
    for (const questId of ['weekly_streak_3', 'weekly_streak_5']) {
        const def = getDefById(questId);
        if (!def) continue;
        if (streak >= def.target) {
            const entry = user.quests?.find(q => q.questId === questId && !q.completedAt && q.expiresAt > new Date());
            if (entry && entry.progress < def.target) {
                entry.progress    = def.target;
                entry.completedAt = new Date();
                completed.push(await awardQuest(user, def, guildSettings));
            }
        }
    }
    return { completed, nearComplete: [] };
}

// Notify the user that a quest is almost done (crossed 80% progress this event)
async function notifyQuestNearComplete(guildSettings, member, quests, fallbackChannel) {
    if (!quests?.length) return;

    const settings = guildSettings?.quests ?? guildSettings;
    const notifChannelId = settings?.notificationChannelId;
    const channel = notifChannelId
        ? (member.guild.channels.cache.get(notifChannelId) ?? fallbackChannel)
        : fallbackChannel;
    if (!channel) return;

    const { EmbedBuilder } = require('discord.js');
    for (const def of quests) {
        if (!def) continue;
        const catEmoji  = CATEGORY_EMOJIS[def.category] ?? '🗺️';
        const diffColor = DIFFICULTY_COLORS[def.difficulty] ?? '🟢';
        const embed = new EmbedBuilder()
            .setColor(0xFEE75C)
            .setAuthor({ name: `${member.displayName} is almost there!`, iconURL: member.displayAvatarURL({ dynamic: true }) })
            .setDescription(`${catEmoji} **${def.name}** ${diffColor}\n${def.description}\n\n> Almost done — keep going!`)
            .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(() => {});
    }
}

// Notify the user that their daily quests have refreshed
async function notifyDailyQuestReset(guildSettings, member, user, fallbackChannel) {
    const settings = guildSettings?.quests ?? guildSettings;
    const notifChannelId = settings?.notificationChannelId;
    const channel = notifChannelId
        ? (member.guild.channels.cache.get(notifChannelId) ?? fallbackChannel)
        : fallbackChannel;
    if (!channel) return;

    const dailyCount = guildSettings?.quests?.questsPerDay ?? 3;
    await channel.send(
        `🗺️ <@${user.userId}> Your **${dailyCount} daily quest${dailyCount !== 1 ? 's' : ''}** have refreshed! Use \`/quests\` to see them.`
    ).catch(() => {});
}

// Send quest completion notification to the configured channel (or fallback channel)
async function notifyQuestComplete(guild, member, rewards, fallbackChannel) {
    if (!rewards?.length) return;

    const settings = guild.settings ?? guild;
    const notifChannelId = settings.quests?.notificationChannelId;
    const channel = notifChannelId
        ? (member.guild.channels.cache.get(notifChannelId) ?? fallbackChannel)
        : fallbackChannel;
    if (!channel) return;

    const { EmbedBuilder } = require('discord.js');
    for (const reward of rewards) {
        if (!reward) continue;
        const def        = reward.def;
        const catEmoji   = CATEGORY_EMOJIS[def?.category] ?? '🗺️';
        const diffColor  = DIFFICULTY_COLORS[def?.difficulty] ?? '🟢';
        const diffName   = def?.difficulty ? (def.difficulty.charAt(0).toUpperCase() + def.difficulty.slice(1)) : 'Quest';
        const embed = new EmbedBuilder()
            .setColor(def?.difficulty === 'hard' ? 0xED4245 : def?.difficulty === 'medium' ? 0xFEE75C : 0x57F287)
            .setAuthor({ name: `${member.displayName} completed a quest!`, iconURL: member.displayAvatarURL({ dynamic: true }) })
            .setDescription(`${catEmoji} **${def?.name ?? 'Quest'}** ${diffColor} ${diffName}\n${def?.description ?? ''}`)
            .addFields(
                { name: 'XP Earned',    value: `+${reward.xp} XP`,      inline: true },
                { name: 'Coins Earned', value: `+${reward.coins} coins`, inline: true }
            )
            .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(() => {});
    }
}

function getQuestDefs() {
    return [
        ...DAILY_QUEST_POOL.map(q => ({ ...q, type: 'daily',  expiresAt: getDailyExpiry()  })),
        ...WEEKLY_QUEST_POOL.map(q => ({ ...q, type: 'weekly', expiresAt: getWeeklyExpiry() })),
    ];
}

function getDailyPool()  { return DAILY_QUEST_POOL;  }
function getWeeklyPool() { return WEEKLY_QUEST_POOL; }
function getCategoryEmojis()  { return CATEGORY_EMOJIS;  }
function getDifficultyColors() { return DIFFICULTY_COLORS; }

function startQuestService() {
    console.log('[QUESTS] Quest service ready (per-user lazy expiry, randomised pool)');
}

module.exports = {
    ensureQuests, getQuestDefs, getDailyPool, getWeeklyPool,
    getCategoryEmojis, getDifficultyColors,
    onMessage, onReaction, onCommandUse, onEconomyEarn, onHunt, onFish, onStreakUpdate,
    awardSeasonXp, notifyQuestComplete, notifyQuestNearComplete, notifyDailyQuestReset,
    startQuestService,
};
