'use strict';

// Built-in achievement definitions.
// Each entry is checked server-side by achievementService against user stats.
// `progress(user)` returns [current, max] for the locked-achievement progress bar.
// `check(user, guildSettings)` returns true when the achievement is earned.
// `secret: true` hides name/description/progress until the achievement is earned.

const ACHIEVEMENTS = [
    // ── Economy ──────────────────────────────────────────────────────────────
    {
        id: 'first_steps',
        name: 'First Steps',
        description: 'Have at least 100 coins total',
        emoji: '💵',
        category: 'economy',
        xpReward: 25,
        coinReward: 0,
        check: (user) => (user.balance + user.bank) >= 100,
        progress: (user) => [Math.min(user.balance + user.bank, 100), 100]
    },
    {
        id: 'coin_hoarder',
        name: 'Coin Hoarder',
        description: 'Save 10,000 coins in the bank',
        emoji: '🪙',
        category: 'economy',
        xpReward: 75,
        coinReward: 500,
        check: (user) => user.bank >= 10_000,
        progress: (user) => [Math.min(user.bank, 10_000), 10_000]
    },
    {
        id: 'wealthy',
        name: 'Wealthy',
        description: 'Save 100,000 coins in the bank',
        emoji: '💎',
        category: 'economy',
        xpReward: 200,
        coinReward: 2_500,
        check: (user) => user.bank >= 100_000,
        progress: (user) => [Math.min(user.bank, 100_000), 100_000]
    },
    {
        id: 'millionaire',
        name: 'Millionaire',
        description: 'Reach 1,000,000 coins in the bank',
        emoji: '🤑',
        category: 'economy',
        xpReward: 500,
        coinReward: 10_000,
        check: (user) => user.bank >= 1_000_000,
        progress: (user) => [Math.min(user.bank, 1_000_000), 1_000_000]
    },
    {
        id: 'lucky',
        name: 'Lucky',
        description: 'Gamble 10,000 coins lifetime',
        emoji: '🎲',
        category: 'economy',
        xpReward: 50,
        coinReward: 200,
        check: (user) => (user.lifetimeGambled || 0) >= 10_000,
        progress: (user) => [Math.min(user.lifetimeGambled || 0, 10_000), 10_000]
    },
    {
        id: 'gambler',
        name: 'Gambler',
        description: 'Gamble 100,000 coins lifetime',
        emoji: '🃏',
        category: 'economy',
        xpReward: 150,
        coinReward: 1_500,
        check: (user) => (user.lifetimeGambled || 0) >= 100_000,
        progress: (user) => [Math.min(user.lifetimeGambled || 0, 100_000), 100_000]
    },
    {
        id: 'high_roller',
        name: 'High Roller',
        description: 'Gamble 1,000,000 coins lifetime',
        emoji: '🎰',
        category: 'economy',
        xpReward: 300,
        coinReward: 5_000,
        check: (user) => (user.lifetimeGambled || 0) >= 1_000_000,
        progress: (user) => [Math.min(user.lifetimeGambled || 0, 1_000_000), 1_000_000]
    },
    {
        id: 'petty_thief',
        name: 'Petty Thief',
        description: 'Successfully rob 5 users',
        emoji: '🕵️',
        category: 'economy',
        xpReward: 50,
        coinReward: 200,
        check: (user) => (user.successfulRobs || 0) >= 5,
        progress: (user) => [Math.min(user.successfulRobs || 0, 5), 5]
    },
    {
        id: 'thief',
        name: 'Thief',
        description: 'Successfully rob 25 users',
        emoji: '🦝',
        category: 'economy',
        xpReward: 100,
        coinReward: 1_000,
        check: (user) => (user.successfulRobs || 0) >= 25,
        progress: (user) => [Math.min(user.successfulRobs || 0, 25), 25]
    },
    {
        id: 'robber_baron',
        name: 'Robber Baron',
        description: 'Successfully rob 50 users',
        emoji: '🦹',
        category: 'economy',
        xpReward: 200,
        coinReward: 2_000,
        check: (user) => (user.successfulRobs || 0) >= 50,
        progress: (user) => [Math.min(user.successfulRobs || 0, 50), 50]
    },

    // ── Leveling ─────────────────────────────────────────────────────────────
    {
        id: 'first_message',
        name: 'First Words',
        description: 'Send your first message',
        emoji: '💬',
        category: 'leveling',
        xpReward: 10,
        coinReward: 0,
        check: (user) => (user.messages || 0) >= 1,
        progress: (user) => [Math.min(user.messages || 0, 1), 1]
    },
    {
        id: 'chatty',
        name: 'Chatty',
        description: 'Send 100 messages',
        emoji: '🗣️',
        category: 'leveling',
        xpReward: 50,
        coinReward: 250,
        check: (user) => (user.messages || 0) >= 100,
        progress: (user) => [Math.min(user.messages || 0, 100), 100]
    },
    {
        id: 'chatterbox',
        name: 'Chatterbox',
        description: 'Send 1,000 messages',
        emoji: '📢',
        category: 'leveling',
        xpReward: 100,
        coinReward: 500,
        check: (user) => (user.messages || 0) >= 1_000,
        progress: (user) => [Math.min(user.messages || 0, 1_000), 1_000]
    },
    {
        id: 'social_butterfly',
        name: 'Social Butterfly',
        description: 'Send 10,000 messages',
        emoji: '🦋',
        category: 'leveling',
        xpReward: 250,
        coinReward: 3_000,
        check: (user) => (user.messages || 0) >= 10_000,
        progress: (user) => [Math.min(user.messages || 0, 10_000), 10_000]
    },
    {
        id: 'level_10',
        name: 'Rising Star',
        description: 'Reach level 10',
        emoji: '⭐',
        category: 'leveling',
        xpReward: 50,
        coinReward: 200,
        check: (user) => user.level >= 10,
        progress: (user) => [Math.min(user.level, 10), 10]
    },
    {
        id: 'level_25',
        name: 'Veteran',
        description: 'Reach level 25',
        emoji: '🌟',
        category: 'leveling',
        xpReward: 100,
        coinReward: 500,
        check: (user) => user.level >= 25,
        progress: (user) => [Math.min(user.level, 25), 25]
    },
    {
        id: 'level_50',
        name: 'Elite',
        description: 'Reach level 50',
        emoji: '💫',
        category: 'leveling',
        xpReward: 250,
        coinReward: 1_500,
        check: (user) => user.level >= 50,
        progress: (user) => [Math.min(user.level, 50), 50]
    },
    {
        id: 'level_100',
        name: 'Legend',
        description: 'Reach level 100',
        emoji: '🏅',
        category: 'leveling',
        xpReward: 1_000,
        coinReward: 10_000,
        check: (user) => user.level >= 100,
        progress: (user) => [Math.min(user.level, 100), 100]
    },

    // ── Hunt ─────────────────────────────────────────────────────────────────
    {
        id: 'first_blood',
        name: 'First Blood',
        description: 'Complete your first hunt',
        emoji: '🏹',
        category: 'hunt',
        xpReward: 25,
        coinReward: 50,
        check: (user) => (user.hunt?.totalHunts || 0) >= 1,
        progress: (user) => [Math.min(user.hunt?.totalHunts || 0, 1), 1]
    },
    {
        id: 'seasoned_hunter',
        name: 'Seasoned Hunter',
        description: 'Complete 100 hunts',
        emoji: '🗡️',
        category: 'hunt',
        xpReward: 100,
        coinReward: 500,
        check: (user) => (user.hunt?.totalHunts || 0) >= 100,
        progress: (user) => [Math.min(user.hunt?.totalHunts || 0, 100), 100]
    },
    {
        id: 'veteran_hunter',
        name: 'Veteran Hunter',
        description: 'Complete 500 hunts',
        emoji: '⚔️',
        category: 'hunt',
        xpReward: 300,
        coinReward: 2_500,
        check: (user) => (user.hunt?.totalHunts || 0) >= 500,
        progress: (user) => [Math.min(user.hunt?.totalHunts || 0, 500), 500]
    },
    {
        id: 'master_hunter',
        name: 'Master Hunter',
        description: 'Complete 1,000 hunts',
        emoji: '🦌',
        category: 'hunt',
        xpReward: 500,
        coinReward: 5_000,
        check: (user) => (user.hunt?.totalHunts || 0) >= 1_000,
        progress: (user) => [Math.min(user.hunt?.totalHunts || 0, 1_000), 1_000]
    },
    {
        id: 'trophy_collector',
        name: 'Trophy Collector',
        description: 'Collect 10 unique trophies',
        emoji: '🏆',
        category: 'hunt',
        xpReward: 300,
        coinReward: 2_000,
        check: (user) => (user.hunt?.trophies?.length || 0) >= 10,
        progress: (user) => [Math.min(user.hunt?.trophies?.length || 0, 10), 10]
    },
    {
        id: 'trophy_wall',
        name: 'Trophy Wall',
        description: 'Collect 25 unique trophies',
        emoji: '🎖️',
        category: 'hunt',
        xpReward: 500,
        coinReward: 4_000,
        check: (user) => (user.hunt?.trophies?.length || 0) >= 25,
        progress: (user) => [Math.min(user.hunt?.trophies?.length || 0, 25), 25]
    },

    // ── Fishing ──────────────────────────────────────────────────────────────
    {
        id: 'gone_fishing',
        name: 'Gone Fishing',
        description: 'Make your first fishing cast',
        emoji: '🎣',
        category: 'fishing',
        xpReward: 25,
        coinReward: 50,
        check: (user) => (user.fishing?.totalCasts || 0) >= 1,
        progress: (user) => [Math.min(user.fishing?.totalCasts || 0, 1), 1]
    },
    {
        id: 'weekend_angler',
        name: 'Weekend Angler',
        description: 'Make 50 fishing casts',
        emoji: '🪝',
        category: 'fishing',
        xpReward: 75,
        coinReward: 300,
        check: (user) => (user.fishing?.totalCasts || 0) >= 50,
        progress: (user) => [Math.min(user.fishing?.totalCasts || 0, 50), 50]
    },
    {
        id: 'angler_pro',
        name: 'Angler Pro',
        description: 'Make 500 fishing casts',
        emoji: '🐟',
        category: 'fishing',
        xpReward: 200,
        coinReward: 2_000,
        check: (user) => (user.fishing?.totalCasts || 0) >= 500,
        progress: (user) => [Math.min(user.fishing?.totalCasts || 0, 500), 500]
    },
    {
        id: 'master_angler',
        name: 'Master Angler',
        description: 'Make 2,000 fishing casts',
        emoji: '🐠',
        category: 'fishing',
        xpReward: 400,
        coinReward: 5_000,
        check: (user) => (user.fishing?.totalCasts || 0) >= 2_000,
        progress: (user) => [Math.min(user.fishing?.totalCasts || 0, 2_000), 2_000]
    },
    {
        id: 'legendary_catch',
        name: 'Legendary Catch',
        description: 'Catch a legendary fish',
        emoji: '🐋',
        category: 'fishing',
        xpReward: 300,
        coinReward: 3_000,
        check: (user) => (user.fishing?.legendaryCatches || 0) >= 1,
        progress: (user) => [Math.min(user.fishing?.legendaryCatches || 0, 1), 1]
    },
    {
        id: 'legendary_obsession',
        name: 'Legendary Obsession',
        description: 'Catch 10 legendary fish',
        emoji: '🌊',
        category: 'fishing',
        xpReward: 500,
        coinReward: 6_000,
        check: (user) => (user.fishing?.legendaryCatches || 0) >= 10,
        progress: (user) => [Math.min(user.fishing?.legendaryCatches || 0, 10), 10]
    },

    // ── Community ────────────────────────────────────────────────────────────
    {
        id: 'week_warrior',
        name: 'Week Warrior',
        description: 'Maintain a 7-day activity streak',
        emoji: '🔥',
        category: 'community',
        xpReward: 100,
        coinReward: 300,
        check: (user) => (user.streak?.current || 0) >= 7,
        progress: (user) => [Math.min(user.streak?.current || 0, 7), 7]
    },
    {
        id: 'fortnight',
        name: 'Fortnight',
        description: 'Maintain a 14-day activity streak',
        emoji: '🌕',
        category: 'community',
        xpReward: 150,
        coinReward: 600,
        check: (user) => (user.streak?.current || 0) >= 14,
        progress: (user) => [Math.min(user.streak?.current || 0, 14), 14]
    },
    {
        id: 'devoted',
        name: 'Devoted',
        description: 'Maintain a 30-day activity streak',
        emoji: '📅',
        category: 'community',
        xpReward: 300,
        coinReward: 1_500,
        check: (user) => (user.streak?.current || 0) >= 30,
        progress: (user) => [Math.min(user.streak?.current || 0, 30), 30]
    },
    {
        id: 'century',
        name: 'Century',
        description: 'Maintain a 100-day activity streak',
        emoji: '💯',
        category: 'community',
        xpReward: 1_000,
        coinReward: 5_000,
        check: (user) => (user.streak?.longest || 0) >= 100,
        progress: (user) => [Math.min(user.streak?.longest || 0, 100), 100]
    },
    {
        id: 'quest_novice',
        name: 'Quest Novice',
        description: 'Complete 10 quests',
        emoji: '📜',
        category: 'community',
        xpReward: 100,
        coinReward: 500,
        check: (user) => (user.questsCompleted || 0) >= 10,
        progress: (user) => [Math.min(user.questsCompleted || 0, 10), 10]
    },
    {
        id: 'quest_veteran',
        name: 'Quest Veteran',
        description: 'Complete 50 quests',
        emoji: '🗺️',
        category: 'community',
        xpReward: 250,
        coinReward: 2_000,
        check: (user) => (user.questsCompleted || 0) >= 50,
        progress: (user) => [Math.min(user.questsCompleted || 0, 50), 50]
    },
    {
        id: 'quest_champion',
        name: 'Quest Champion',
        description: 'Complete 100 quests',
        emoji: '🏺',
        category: 'community',
        xpReward: 500,
        coinReward: 5_000,
        check: (user) => (user.questsCompleted || 0) >= 100,
        progress: (user) => [Math.min(user.questsCompleted || 0, 100), 100]
    },
    {
        id: 'season_champion',
        name: 'Season Champion',
        description: 'Reach the final tier of a season pass',
        emoji: '🥇',
        category: 'community',
        xpReward: 1_000,
        coinReward: 10_000,
        check: (user, guild) => {
            if (!guild?.season?.enabled || !guild.season.maxTiers) return false;
            return (user.season?.tier || 0) >= guild.season.maxTiers;
        },
        progress: (user, guild) => {
            const max = guild?.season?.maxTiers || 50;
            return [Math.min(user.season?.tier || 0, max), max];
        }
    },

    // ── Moderation ────────────────────────────────────────────────────────────
    {
        id: 'clean_record',
        name: 'Clean Record',
        description: '30 days without receiving a warning',
        emoji: '🕊️',
        category: 'moderation',
        xpReward: 150,
        coinReward: 500,
        check: (user) => {
            if (!user.lastWarnedAt) return false;
            const daysSince = (Date.now() - new Date(user.lastWarnedAt).getTime()) / 864e5;
            return daysSince >= 30;
        },
        progress: (user) => {
            if (!user.lastWarnedAt) return [0, 30];
            const daysSince = Math.min(Math.floor((Date.now() - new Date(user.lastWarnedAt).getTime()) / 864e5), 30);
            return [daysSince, 30];
        }
    },

    // ── Secret ────────────────────────────────────────────────────────────────
    // Secret achievements are hidden (name/description/progress concealed) until earned.
    {
        id: 'completionist',
        name: 'Completionist',
        description: 'Earn 20 non-secret achievements',
        emoji: '🌈',
        category: 'community',
        secret: true,
        xpReward: 1_000,
        coinReward: 15_000,
        check: (user) => {
            const earnedIds = new Set((user.achievements || []).map(a => a.id));
            return ACHIEVEMENTS.filter(a => !a.secret && earnedIds.has(a.id)).length >= 20;
        },
        progress: (user) => {
            const earnedIds = new Set((user.achievements || []).map(a => a.id));
            const count = ACHIEVEMENTS.filter(a => !a.secret && earnedIds.has(a.id)).length;
            return [Math.min(count, 20), 20];
        }
    },
    {
        id: 'unstoppable',
        name: 'Unstoppable',
        description: 'Maintain a 365-day activity streak',
        emoji: '⚡',
        category: 'community',
        secret: true,
        xpReward: 2_000,
        coinReward: 25_000,
        check: (user) => (user.streak?.longest || 0) >= 365,
        progress: (user) => [Math.min(user.streak?.longest || 0, 365), 365]
    },
    {
        id: 'apex_predator',
        name: 'Apex Predator',
        description: 'Complete 5,000 hunts',
        emoji: '🐺',
        category: 'hunt',
        secret: true,
        xpReward: 1_500,
        coinReward: 20_000,
        check: (user) => (user.hunt?.totalHunts || 0) >= 5_000,
        progress: (user) => [Math.min(user.hunt?.totalHunts || 0, 5_000), 5_000]
    },
    {
        id: 'fishing_legend',
        name: 'Fishing Legend',
        description: 'Make 5,000 fishing casts',
        emoji: '🐉',
        category: 'fishing',
        secret: true,
        xpReward: 1_500,
        coinReward: 20_000,
        check: (user) => (user.fishing?.totalCasts || 0) >= 5_000,
        progress: (user) => [Math.min(user.fishing?.totalCasts || 0, 5_000), 5_000]
    },
];

const CATEGORY_LABELS = {
    economy: 'Economy',
    leveling: 'Leveling',
    hunt: 'Hunt',
    fishing: 'Fishing',
    community: 'Community',
    moderation: 'Moderation',
    custom: 'Custom'
};

const CATEGORY_EMOJIS = {
    economy: '💰',
    leveling: '📈',
    hunt: '🏹',
    fishing: '🎣',
    community: '👥',
    moderation: '🛡️',
    custom: '⚙️'
};

module.exports = { ACHIEVEMENTS, CATEGORY_LABELS, CATEGORY_EMOJIS };
