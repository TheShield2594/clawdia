// Season pass tier table — 50 tiers across a free track and a premium track.
//
// The premium track is unlocked with a large coin payment (see season.unlock),
// making it the economy's primary deliberate money sink: it drains a big chunk
// of a player's balance in exchange for cosmetic/consumable rewards rather than
// minting new currency.
//
// Each tier: { tier, free: {coins,itemId,label}, premium: {coins,itemId,label} }.
// itemId (when present) grants 1× of that shop item on claim; label is display.

const TIER_COUNT  = 50;
const XP_PER_TIER = 100; // 5,000 season XP to reach tier 50

// Milestone item rewards keyed by tier. Free track gets the occasional
// consumable; premium gets something at every milestone plus exclusive items.
const FREE_ITEMS = {
    5:  { itemId: 'lucky_charm',     label: '🍀 Lucky Charm' },
    10: { itemId: 'lifesaver',       label: '🛟 Lifesaver' },
    15: { itemId: 'xp_booster_2x',   label: '⭐ 2x XP Booster' },
    20: { itemId: 'streak_shield',   label: '❄️ Streak Shield' },
    25: { itemId: 'coin_booster_2x', label: '💰 2x Coin Booster' },
    30: { itemId: 'lucky_charm',     label: '🍀 Lucky Charm' },
    35: { itemId: 'lifesaver',       label: '🛟 Lifesaver' },
    40: { itemId: 'xp_booster_2x',   label: '⭐ 2x XP Booster' },
    45: { itemId: 'streak_shield',   label: '❄️ Streak Shield' },
    50: { itemId: 'lifesaver',       label: '🛟 Lifesaver' },
};

const PREMIUM_ITEMS = {
    1:  { itemId: 'lucky_charm',       label: '🍀 Lucky Charm' },
    5:  { itemId: 'coin_booster_2x',   label: '💰 2x Coin Booster' },
    10: { itemId: 'salary_raise',      label: '📈 Salary Raise' },
    15: { itemId: 'knife',             label: '🔪 Knife' },
    20: { itemId: 'padlock',           label: '🔒 Padlock' },
    25: { itemId: 'invisibility_cloak',label: '🧥 Invisibility Cloak' },
    30: { itemId: 'robbery_bag',       label: '💼 Robbery Bag' },
    35: { itemId: 'shield',            label: '🛡️ Shield' },
    40: { itemId: 'lucky_streak',      label: '🎯 Lucky Streak' },
    45: { itemId: 'coin_booster_2x',   label: '💰 2x Coin Booster' },
    50: { itemId: 'lifesaver',         label: '🛟 Lifesaver' },
};

// Cosmetic badge labels on free-track tiers that have no item.
const FREE_BADGES = {
    8:  '🎖️ Apprentice Badge',
    18: '🎭 Prestige Frame',
    28: '🌟 Elite Badge',
    38: '💫 Radiant Badge',
    48: '🔥 Legend Badge',
};

const PREMIUM_BADGES = {
    50: '👑 Season Sovereign Title',
};

// Free coins scale gently; premium coins are richer. Coins are a faucet, so
// they're modest relative to the premium unlock cost (premium is a net sink).
function freeCoins(tier) {
    if (FREE_ITEMS[tier] || FREE_BADGES[tier]) return 0;
    return 300 + tier * 60; // tier 1 → 360, tier 49 → ~3,240
}

function premiumCoins(tier) {
    if (PREMIUM_ITEMS[tier] || PREMIUM_BADGES[tier]) return Math.round((400 + tier * 80) / 2);
    return 400 + tier * 80; // tier 1 → 480, tier 49 → ~4,320
}

function buildTierTable() {
    const table = [];
    for (let tier = 1; tier <= TIER_COUNT; tier++) {
        const fItem  = FREE_ITEMS[tier];
        const fBadge = FREE_BADGES[tier];
        const fCoins = freeCoins(tier);
        const free = {
            coins:  fCoins,
            itemId: fItem?.itemId ?? null,
            label:  fItem?.label ?? fBadge ?? `💰 ${fCoins.toLocaleString()} coins`,
        };

        const pItem  = PREMIUM_ITEMS[tier];
        const pBadge = PREMIUM_BADGES[tier];
        const pCoins = premiumCoins(tier);
        const premium = {
            coins:  pCoins,
            itemId: pItem?.itemId ?? null,
            label:  pItem
                ? (pCoins > 0 ? `${pItem.label} + 💰 ${pCoins.toLocaleString()}` : pItem.label)
                : pBadge ?? `💰 ${pCoins.toLocaleString()} coins`,
        };

        table.push({ tier, free, premium });
    }
    return table;
}

const TIER_TABLE = buildTierTable();

// Flavor lore shown on claim embeds (one per tier, cycled if short).
const TIER_LORE = [
    'Every journey starts with a single step.',
    'The spark of ambition ignites here.',
    'Diligence rewarded — this is just the beginning.',
    'Forged in discipline, tempered by purpose.',
    'The climb steepens, and so does your resolve.',
    'Momentum is a force of its own now.',
    'Few make it this far. Fewer keep going.',
    'Your name is starting to echo in the halls.',
    'Mastery is not given. It is taken, tier by tier.',
    'The summit is no longer a rumor — it is a destination.',
];

function loreForTier(tier) {
    return TIER_LORE[(tier - 1) % TIER_LORE.length];
}

module.exports = {
    TIER_COUNT,
    XP_PER_TIER,
    TIER_TABLE,
    buildTierTable,
    loreForTier,
};
