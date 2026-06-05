const DROP_TABLE = [
    { itemId: 'lucky_charm',   weight: 35, emoji: '🍀', name: 'Lucky Charm' },
    { itemId: 'coin_booster',  weight: 25, emoji: '💰', name: 'Coin Booster (30min)' },
    { itemId: 'xp_booster',    weight: 20, emoji: '⭐', name: 'XP Booster (30min)' },
    { itemId: 'streak_shield', weight: 12, emoji: '🛡️', name: 'Streak Shield' },
    { itemId: 'lifesaver',     weight: 8,  emoji: '🛟', name: 'Lifesaver' },
];

// Milestone drops — tiered by streak milestone (7 / 30 / 100)
const RARE_DROP_TABLE = [
    { itemId: 'lifesaver',      weight: 50, emoji: '🛟', name: 'Lifesaver',            milestone: 7   },
    { itemId: 'streak_shield',  weight: 30, emoji: '🛡️', name: 'Streak Shield',         milestone: 7   },
    { itemId: 'coin_booster',   weight: 20, emoji: '💰', name: 'Coin Booster (2hr)',    milestone: 30  },
    { itemId: 'xp_booster',     weight: 20, emoji: '⭐', name: 'XP Booster (2hr)',      milestone: 30  },
    { itemId: 'lifesaver',      weight: 55, emoji: '🛟', name: 'Lifesaver',             milestone: 100 },
    { itemId: 'revival_token',  weight: 5,  emoji: '💫', name: 'Streak Revival Token',  milestone: 100, streakFlag: true },
];

const DROP_MILESTONES = [7, 30, 100];
const DROP_BASE_CHANCE = 0.05;

function weightedRandom(table) {
    const total = table.reduce((sum, e) => sum + e.weight, 0);
    let r = Math.random() * total;
    for (const entry of table) {
        r -= entry.weight;
        if (r <= 0) return entry;
    }
    return table[table.length - 1];
}

module.exports = { DROP_TABLE, RARE_DROP_TABLE, DROP_MILESTONES, DROP_BASE_CHANCE, weightedRandom };
