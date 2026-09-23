// The boosters drop as the shop's own 2x booster items, whose effect runs for
// an hour. They used to drop as `coin_booster` / `xp_booster`, labelled 30 min
// and 2 hr — ids no effect was mapped to and durations no effect had, so the
// item could never be activated at all. Legacy stacks still activate through
// the alias in effectsService and display through itemDisplay's.
const DROP_TABLE = [
    { itemId: 'lucky_charm',   weight: 35, emoji: '🍀', name: 'Lucky Charm' },
    { itemId: 'coin_booster_2x', weight: 25, emoji: '💰', name: '2x Coin Booster (1hr)' },
    { itemId: 'xp_booster_2x',   weight: 20, emoji: '⭐', name: '2x XP Booster (1hr)' },
    { itemId: 'streak_shield', weight: 12, emoji: '🛡️', name: 'Streak Shield' },
    { itemId: 'lifesaver',     weight: 8,  emoji: '🛟', name: 'Lifesaver' },
];

// Milestone drops — tiered by streak milestone (7 / 30 / 100)
const RARE_DROP_TABLE = [
    { itemId: 'lifesaver',      weight: 50, emoji: '🛟', name: 'Lifesaver',            milestone: 7   },
    { itemId: 'streak_shield',  weight: 30, emoji: '🛡️', name: 'Streak Shield',         milestone: 7   },
    { itemId: 'coin_booster_2x', weight: 20, emoji: '💰', name: '2x Coin Booster (1hr)', milestone: 30  },
    { itemId: 'xp_booster_2x',   weight: 20, emoji: '⭐', name: '2x XP Booster (1hr)',   milestone: 30  },
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
