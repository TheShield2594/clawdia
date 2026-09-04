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

    // Joint (cross-system) quests — progress increments from hunt AND fish
    { questId: 'daily_joint_hunt_fish', name: 'Jack of All Trades', description: 'Complete 3 hunts AND 3 fishing casts (6 total)',
      target: 6, difficulty: 'hard', category: 'joint' },
    { questId: 'daily_mine_3',          name: 'Rock Solid',         description: 'Mine 3 times',
      target: 3, difficulty: 'medium', category: 'mining' },
    { questId: 'daily_explore_3',       name: 'Off the Path',       description: 'Set out on 3 expeditions',
      target: 3, difficulty: 'medium', category: 'exploration' },
    { questId: 'daily_explore_5',       name: 'Blank Spaces',       description: 'Set out on 5 expeditions',
      target: 5, difficulty: 'hard', category: 'exploration' },
    { questId: 'daily_pet_care_3',      name: 'Good Owner',         description: 'Feed, play with or rest your pets 3 times',
      target: 3, difficulty: 'easy', category: 'pets' },
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

    // Joint (cross-system) weekly quests
    { questId: 'weekly_joint_hunt_fish_mine', name: 'Triple Threat',  description: 'Complete 10 hunts, 10 fishing casts, and 5 mines (25 total activities)',
      target: 25, difficulty: 'hard', category: 'joint' },
    { questId: 'weekly_mine_15',              name: 'Deep Dive',      description: 'Mine 15 times this week',
      target: 15, difficulty: 'medium', category: 'mining' },
    { questId: 'weekly_explore_20',           name: 'Cartographer',   description: 'Set out on 20 expeditions this week',
      target: 20, difficulty: 'medium', category: 'exploration' },
    { questId: 'weekly_pet_care_15',          name: 'Devoted Owner',  description: 'Care for your pets 15 times this week',
      target: 15, difficulty: 'medium', category: 'pets' },
];

const CATEGORY_EMOJIS = {
    social:  '💬',
    explore: '🔍',
    exploration: '🧭',
    economy: '💰',
    hunt:    '🏹',
    fishing: '🎣',
    mining:  '⛏️',
    joint:   '🔗',
    pets:    '🐾',
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

// Unbiased in-place Fisher-Yates (Durstenfeld) shuffle — returns a new array
function shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
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
    const shuffled = shuffle(entries);
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
        const remaining = shuffle(pool.filter(q => !seen.has(q.questId)));
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
    // Assigning a plain array back over the document array rebuilds it — every
    // entry re-cast into a subdocument — and this runs on every message, for a
    // list that actually changes twice a day (#893). Mongoose compares the two
    // and correctly declines to mark the path modified, so no write was at
    // stake; the cast itself is what is skipped when nothing expired, along
    // with the churn of handing the callers below a different array object each
    // time.
    const existing = user.quests;
    const unexpired = (existing || []).filter(q => q.expiresAt > now);
    if (!Array.isArray(existing) || unexpired.length !== existing.length) user.quests = unexpired;

    const dailyCount  = guildSettings.quests.questsPerDay  ?? 3;
    const weeklyCount = guildSettings.quests.questsPerWeek ?? 2;
    const userLevel   = user.level || 1;

    const activeIds = new Set(user.quests.map(q => q.questId));

    const dailyExpiry  = getDailyExpiry();
    const weeklyExpiry = getWeeklyExpiry();

    // Classify by exact expiry match. On Saturday dailyExpiryMs === weeklyExpiryMs, so
    // using exact equality for both means quests are counted toward both limits and no
    // extras are assigned — safer than the old t < weeklyExpiryMs / t >= weeklyExpiryMs
    // approach which left activeDailyIds empty on the boundary day.
    const dailyExpiryMs  = dailyExpiry.getTime();
    const weeklyExpiryMs = weeklyExpiry.getTime();
    const activeDailyIds  = user.quests.filter(q => q.expiresAt.getTime() === dailyExpiryMs).map(q => q.questId);
    const activeWeeklyIds = user.quests.filter(q => q.expiresAt.getTime() === weeklyExpiryMs).map(q => q.questId);

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

// The quest ids each per-event hook ticks, and the AI-quest mechanic it also
// advances. Named here rather than inline in the hooks because the hot paths
// ask a second question of the same lists — "could this event move anything for
// this user at all?" — before they pay for a full document hydrate and save
// (#893, #898, #929). Two copies of these ids would drift, and the failure mode
// of drift is a quest that silently stops progressing.
const QUEST_EVENTS = {
    message: {
        ids: ['daily_messages_5', 'daily_messages_10', 'daily_messages_25', 'daily_messages_50',
              'weekly_messages_50', 'weekly_messages_150', 'weekly_messages_300'],
        aiMechanic: 'social',
    },
    reaction: {
        ids: ['daily_reactions_3', 'daily_reactions_5', 'daily_reactions_10', 'daily_reactions_20'],
        aiMechanic: null,
    },
    command: {
        ids: ['daily_commands_2', 'daily_commands_5', 'daily_commands_10',
              'weekly_commands_10', 'weekly_commands_25'],
        aiMechanic: 'explore',
    },
    streak: {
        ids: ['weekly_streak_3', 'weekly_streak_5'],
        aiMechanic: null,
    },
};

// A quest entry this event could still advance: assigned, unfinished, unexpired.
function isLive(entry, now) {
    return !entry.completedAt && new Date(entry.expiresAt).getTime() > now;
}

/**
 * Whether `on<Event>` could move anything for a user holding `quests`.
 *
 * Answers from the quest list alone, so a caller can ask it of a projected
 * `{ quests: 1 }` read and skip hydrating the whole user document when the
 * answer is no — which it is for most users most of the time, since the
 * per-event quests are a handful of ids that are finished early in the day.
 *
 * AI legendary quests are matched on the `ai_` prefix rather than on their
 * mechanic: the mechanic lives in a separate collection, and reading it would
 * cost the round trip this check exists to avoid. So an active AI quest of any
 * mechanic answers yes — conservative in the direction that cannot lose
 * progress, and rare enough not to matter.
 */
function questEventCanProgress(quests, event) {
    const spec = QUEST_EVENTS[event];
    if (!spec) return true;
    const now = Date.now();
    return (quests || []).some(q =>
        isLive(q, now) && (spec.ids.includes(q.questId) || (spec.aiMechanic && q.questId.startsWith('ai_'))),
    );
}

/**
 * Whether `ensureQuests` would add or remove anything — a fresh daily set, a
 * topped-up weekly set, or an expired entry to prune.
 *
 * Same contract as `questEventCanProgress`: quest list in, boolean out, safe to
 * ask of a lean projection. Callers pair the two so that a user whose quests
 * have rolled over still gets the full path even though no event quest is live.
 */
function questAssignmentNeeded(quests, guildSettings) {
    if (!guildSettings?.quests?.enabled) return false;

    const now = Date.now();
    const entries = quests || [];
    const unexpired = entries.filter(q => new Date(q.expiresAt).getTime() > now);
    if (unexpired.length !== entries.length) return true;

    const dailyExpiryMs  = getDailyExpiry().getTime();
    const weeklyExpiryMs = getWeeklyExpiry().getTime();
    const countAt = ms => unexpired.filter(q => new Date(q.expiresAt).getTime() === ms).length;

    return countAt(dailyExpiryMs)  < (guildSettings.quests.questsPerDay  ?? 3)
        || countAt(weeklyExpiryMs) < (guildSettings.quests.questsPerWeek ?? 2);
}

function getDefById(questId) {
    return DAILY_QUEST_POOL.find(d => d.questId === questId)
        || WEEKLY_QUEST_POOL.find(d => d.questId === questId)
        || null;
}

// Increment progress on an active quest.
// Returns { completed: def|null, nearComplete: def|null }.
// nearComplete fires once when progress first crosses 80% without completing.
// defOverride allows callers to pass a pre-loaded definition (avoids duplicate DB lookups for AI quests).
async function incrementQuest(user, questId, amount = 1, defOverride = null) {
    const entry = user.quests?.find(q => q.questId === questId && !q.completedAt && q.expiresAt > new Date());
    if (!entry) return { completed: null, nearComplete: null };

    let def = defOverride;
    if (!def) {
        if (questId.startsWith('ai_')) {
            const AiQuest = require('../models/AiQuest');
            def = await AiQuest.findOne({ questId }).lean();
        } else {
            def = getDefById(questId);
        }
    }
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
    // AI legendary quests carry their own reward values
    if (questDef.questId?.startsWith('ai_')) {
        const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
        const xp    = Math.round((questDef.xpReward    ?? 500) * streakMult);
        const coins = Math.round((questDef.coinReward   ?? 250) * streakMult);
        user.xp      += xp;
        user.balance += coins;
        user.questsCompleted = (user.questsCompleted || 0) + 1;
        await awardSeasonXp(user, xp, guildSettings);
        return { xp, coins, def: questDef };
    }

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
    if (!season?.enabled || !season.seasonId) return 0;
    if (user.season?.seasonId !== season.seasonId) {
        user.season = { seasonId: season.seasonId, xp: 0, tier: 0, claimedTiers: [], premium: false, claimedPremiumTiers: [], weekXp: 0, weekStart: null };
    }

    // Weekly XP cap (pacing): roll the window over after 7 days and clamp the
    // grant so the pass can't be finished in a few days of grinding.
    const weeklyCap = season.weeklyXpCap || 0;
    if (weeklyCap > 0) {
        const now = Date.now();
        const weekStart = user.season.weekStart ? new Date(user.season.weekStart).getTime() : 0;
        if (!weekStart || now - weekStart >= 7 * 24 * 60 * 60 * 1000) {
            user.season.weekStart = new Date();
            user.season.weekXp = 0;
        }
        const remaining = Math.max(0, weeklyCap - (user.season.weekXp || 0));
        xp = Math.min(xp, remaining);
        if (xp <= 0) return 0;
        user.season.weekXp = (user.season.weekXp || 0) + xp;
    }

    user.season.xp = (user.season.xp || 0) + xp;
    const xpPerTier = season.xpPerTier || 100;
    const maxTiers  = season.maxTiers  || 50;
    user.season.tier = Math.min(Math.floor(user.season.xp / xpPerTier), maxTiers);
    return xp;
}

// ── Event hooks ──────────────────────────────────────────────────────────────

async function onMessage(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of QUEST_EVENTS.message.ids) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    const ai = await incrementAiQuestsForMechanic(user, QUEST_EVENTS.message.aiMechanic, 1, guildSettings);
    completed.push(...ai.completed); nearComplete.push(...ai.nearComplete);
    return { completed, nearComplete };
}

async function onReaction(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of QUEST_EVENTS.reaction.ids) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

// Increment any active AI legendary quests matching the given mechanic.
async function incrementAiQuestsForMechanic(user, mechanic, amount, guildSettings) {
    const AiQuest = require('../models/AiQuest');
    const now = new Date();
    const aiEntries = (user.quests || []).filter(q =>
        q.questId.startsWith('ai_') && !q.completedAt && q.expiresAt > now
    );
    if (!aiEntries.length) return { completed: [], nearComplete: [] };

    const completed = [], nearComplete = [];
    for (const entry of aiEntries) {
        const aiDef = await AiQuest.findOne({ questId: entry.questId, mechanic }).lean();
        if (!aiDef) continue;
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, entry.questId, amount, aiDef);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onCommandUse(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of QUEST_EVENTS.command.ids) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    const ai = await incrementAiQuestsForMechanic(user, QUEST_EVENTS.command.aiMechanic, 1, guildSettings);
    completed.push(...ai.completed); nearComplete.push(...ai.nearComplete);
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
    const ai = await incrementAiQuestsForMechanic(user, 'economy', amount, guildSettings);
    completed.push(...ai.completed); nearComplete.push(...ai.nearComplete);
    return { completed, nearComplete };
}

async function onHunt(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_hunt_1', 'daily_hunt_5', 'weekly_hunt_10', 'weekly_hunt_25',
                           'daily_joint_hunt_fish', 'weekly_joint_hunt_fish_mine']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    const ai = await incrementAiQuestsForMechanic(user, 'hunt', 1, guildSettings);
    completed.push(...ai.completed); nearComplete.push(...ai.nearComplete);
    return { completed, nearComplete };
}

async function onFish(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_fish_1', 'daily_fish_5', 'weekly_fish_10', 'weekly_fish_25',
                           'daily_joint_hunt_fish', 'weekly_joint_hunt_fish_mine']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    const ai = await incrementAiQuestsForMechanic(user, 'fishing', 1, guildSettings);
    completed.push(...ai.completed); nearComplete.push(...ai.nearComplete);
    return { completed, nearComplete };
}

async function onMine(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_mine_3', 'weekly_mine_15', 'weekly_joint_hunt_fish_mine']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    const ai = await incrementAiQuestsForMechanic(user, 'mining', 1, guildSettings);
    completed.push(...ai.completed); nearComplete.push(...ai.nearComplete);
    return { completed, nearComplete };
}

/** One expedition, whatever it turned up. */
async function onExplore(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_explore_3', 'daily_explore_5', 'weekly_explore_20']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    // NB: the AI-quest mechanic named 'explore' means "used a bot command" and is
    // driven by onCommandUse. Expeditions are their own thing; wiring them to that
    // mechanic here would double-count every /explore go against it.
    return { completed, nearComplete };
}

/** Any pet interaction: feeding, playing, resting or battling. */
async function onPetCare(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const completed = [], nearComplete = [];
    for (const questId of ['daily_pet_care_3', 'weekly_pet_care_15']) {
        const { completed: def, nearComplete: nearDef } = await incrementQuest(user, questId);
        if (def)     completed.push(await awardQuest(user, def, guildSettings));
        if (nearDef) nearComplete.push(nearDef);
    }
    return { completed, nearComplete };
}

async function onStreakUpdate(user, guildSettings) {
    if (!guildSettings?.quests?.enabled) return { completed: [], nearComplete: [] };
    const streak       = user.streak?.current || 0;
    const completed    = [];
    const nearComplete = [];
    for (const questId of QUEST_EVENTS.streak.ids) {
        const def = getDefById(questId);
        if (!def) continue;
        const entry = user.quests?.find(q => q.questId === questId && !q.completedAt && q.expiresAt > new Date());
        if (!entry) continue;

        const prevProgress = entry.progress || 0;
        entry.progress = Math.min(streak, def.target);

        if (entry.progress >= def.target) {
            entry.completedAt = new Date();
            completed.push(await awardQuest(user, def, guildSettings));
            continue;
        }

        // Fire near-complete exactly once: when crossing the 80% threshold.
        // Clamped below target so small targets (e.g. 3) can't make the
        // threshold equal the target, which would make this branch unreachable.
        const threshold = Math.min(Math.ceil(def.target * 0.8), def.target - 1);
        if (entry.progress >= threshold && prevProgress < threshold) {
            nearComplete.push(def);
        }
    }
    return { completed, nearComplete };
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

// Returns the next incomplete daily quest for a user, or null.
function _nextQuest(user) {
    const now  = new Date();
    const active = (user?.quests ?? []).filter(q => !q.completedAt && q.expiresAt > now);
    if (!active.length) return null;
    const def = getDefById(active[0].questId);
    if (!def) return null;
    const pct = active[0].progress ? Math.floor((active[0].progress / def.target) * 100) : 0;
    return { def, progress: active[0].progress ?? 0, pct };
}

// Send quest completion notification — includes QUEST COMPLETE banner + next-quest preview.
// `user` is optional; pass it to include the "Up Next" teaser.
async function notifyQuestComplete(guild, member, rewards, fallbackChannel, user) {
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
        const def       = reward.def;
        const catEmoji  = CATEGORY_EMOJIS[def?.category] ?? '🗺️';
        const diffColor = DIFFICULTY_COLORS[def?.difficulty] ?? '🟢';
        const diffName  = def?.difficulty ? (def.difficulty.charAt(0).toUpperCase() + def.difficulty.slice(1)) : 'Quest';

        const embed = new EmbedBuilder()
            .setColor(def?.difficulty === 'hard' ? 0xED4245 : def?.difficulty === 'medium' ? 0xFEE75C : 0x57F287)
            .setAuthor({ name: `${member.displayName} completed a quest!`, iconURL: member.displayAvatarURL({ dynamic: true }) })
            .setTitle('✅ QUEST COMPLETE')
            .setDescription(`${catEmoji} **${def?.name ?? 'Quest'}** ${diffColor} ${diffName}\n*${def?.description ?? ''}*`)
            .addFields(
                { name: '✨ XP Earned',    value: `+${reward.xp} XP`,       inline: true },
                { name: '💰 Coins Earned', value: `+${reward.coins} coins`,  inline: true },
            )
            .setTimestamp();

        // Next-quest teaser (anticipation loop)
        const next = _nextQuest(user);
        if (next) {
            const nextCat = CATEGORY_EMOJIS[next.def.category] ?? '🗺️';
            const bar     = next.pct > 0 ? ` (${next.pct}% done)` : '';
            embed.addFields({
                name:   '▶️ Up Next',
                value:  `${nextCat} **${next.def.name}** — *${next.def.description}*${bar}`,
                inline: false,
            });
        }

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
    ensureQuests, questEventCanProgress, questAssignmentNeeded,
    getQuestDefs, getDailyPool, getWeeklyPool,
    getCategoryEmojis, getDifficultyColors,
    onMessage, onReaction, onCommandUse, onEconomyEarn, onHunt, onFish, onMine, onExplore, onPetCare, onStreakUpdate,
    awardSeasonXp, awardQuest, incrementAiQuestsForMechanic,
    notifyQuestComplete, notifyQuestNearComplete, notifyDailyQuestReset,
    startQuestService,
};
