const DROP_TABLE = [
    { itemId: 'lucky_charm',   weight: 35, emoji: '🍀', name: 'Lucky Charm' },
    { itemId: 'coin_booster',  weight: 25, emoji: '💰', name: 'Coin Booster (30min)' },
    { itemId: 'xp_booster',    weight: 20, emoji: '⭐', name: 'XP Booster (30min)' },
    { itemId: 'streak_shield', weight: 12, emoji: '🛡️', name: 'Streak Shield' },
    { itemId: 'lifesaver',     weight: 8,  emoji: '💎', name: 'Lifesaver' },
];

const RARE_DROP_TABLE = [
    { itemId: 'streak_shield', weight: 60, emoji: '🛡️', name: 'Streak Shield' },
    { itemId: 'lifesaver',     weight: 40, emoji: '💎', name: 'Lifesaver' },
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
