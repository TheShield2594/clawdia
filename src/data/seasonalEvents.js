// Seasonal and limited-time event definitions

const SEASONAL_EVENTS = {
    winter_wonderland: {
        id: 'winter_wonderland',
        name: 'Winter Wonderland',
        emoji: '❄️',
        description: 'A magical winter celebration with snowball fights and exclusive winter items!',
        color: '#a8d8f0',
        currency: { id: 'snowflakes', name: 'Snowflakes', emoji: '❄️' },
        xpMultiplier: 1.5,
        coinMultiplier: 1.0,
        // Month range: December (month index 11, days 1-31)
        autoStart: { month: 12, dayStart: 1, dayEnd: 31 },
        lootBox: {
            itemId: 'winter_loot_box',
            name: 'Winter Loot Box',
            emoji: '🎁',
            items: [
                { itemId: 'snowflake_crown',   name: 'Snowflake Crown',   emoji: '👑', rarity: 'legendary', currencyValue: 50 },
                { itemId: 'warm_scarf',        name: 'Warm Scarf',        emoji: '🧣', rarity: 'rare',      currencyValue: 20 },
                { itemId: 'hot_cocoa',         name: 'Hot Cocoa',         emoji: '☕', rarity: 'common',    currencyValue: 5  },
                { itemId: 'snowglobe',         name: 'Snow Globe',        emoji: '🔮', rarity: 'uncommon',  currencyValue: 15 },
                { itemId: 'winter_boots',      name: 'Winter Boots',      emoji: '👢', rarity: 'rare',      currencyValue: 25 },
                { itemId: 'candy_cane',        name: 'Candy Cane',        emoji: '🍬', rarity: 'common',    currencyValue: 5  },
            ],
        },
        shop: [
            { itemId: 'winter_loot_box',  name: 'Winter Loot Box',  emoji: '🎁',  cost: 50,  description: 'Contains exclusive winter items' },
            { itemId: 'snowflake_crown',  name: 'Snowflake Crown',  emoji: '👑',  cost: 300, description: 'Legendary collectible crown' },
            { itemId: 'coin_booster_2x',  name: '2x Coin Booster',  emoji: '💰🚀', cost: 80,  description: '2x coins for 1 hour' },
            { itemId: 'xp_booster_2x',    name: '2x XP Booster',    emoji: '⭐🚀', cost: 80,  description: '2x XP for 1 hour' },
        ],
    },

    spooky_season: {
        id: 'spooky_season',
        name: 'Spooky Season',
        emoji: '🎃',
        description: 'Trick or treat! Haunted zones, Halloween loot boxes, and candy drops await.',
        color: '#ff6b00',
        currency: { id: 'candy', name: 'Candy', emoji: '🍬' },
        xpMultiplier: 1.0,
        coinMultiplier: 1.0,
        // Month range: October (month index 9, days 1-31)
        autoStart: { month: 10, dayStart: 1, dayEnd: 31 },
        lootBox: {
            itemId: 'halloween_loot_box',
            name: 'Halloween Loot Box',
            emoji: '🎃',
            items: [
                { itemId: 'witchs_hat',       name: "Witch's Hat",      emoji: '🧙', rarity: 'legendary', currencyValue: 50 },
                { itemId: 'ghost_costume',    name: 'Ghost Costume',    emoji: '👻', rarity: 'rare',      currencyValue: 20 },
                { itemId: 'candy_bag',        name: 'Candy Bag',        emoji: '🍬', rarity: 'common',    currencyValue: 5  },
                { itemId: 'pumpkin_lantern',  name: 'Pumpkin Lantern',  emoji: '🎃', rarity: 'uncommon',  currencyValue: 15 },
                { itemId: 'black_cat',        name: 'Black Cat',        emoji: '🐈', rarity: 'rare',      currencyValue: 25 },
                { itemId: 'spider_web',       name: 'Spider Web',       emoji: '🕸️', rarity: 'common',    currencyValue: 5  },
            ],
        },
        shop: [
            { itemId: 'halloween_loot_box', name: 'Halloween Loot Box', emoji: '🎃',  cost: 50,  description: 'Contains spooky exclusive items' },
            { itemId: 'witchs_hat',         name: "Witch's Hat",        emoji: '🧙',  cost: 300, description: 'Legendary Halloween collectible' },
            { itemId: 'lucky_charm',        name: 'Lucky Charm',        emoji: '🍀',  cost: 60,  description: '2h luck boost for games' },
            { itemId: 'coin_booster_2x',    name: '2x Coin Booster',    emoji: '💰🚀', cost: 80,  description: '2x coins for 1 hour' },
        ],
    },

    summer_festival: {
        id: 'summer_festival',
        name: 'Summer Festival',
        emoji: '☀️',
        description: 'Fishing tournaments, summer drops, and beach vibes all month long!',
        color: '#ffd700',
        currency: { id: 'shells', name: 'Shells', emoji: '🐚' },
        xpMultiplier: 1.0,
        coinMultiplier: 1.25,
        // Month range: July (month index 6, days 1-31)
        autoStart: { month: 7, dayStart: 1, dayEnd: 31 },
        lootBox: {
            itemId: 'summer_loot_box',
            name: 'Summer Loot Box',
            emoji: '🌊',
            items: [
                { itemId: 'golden_surfboard',  name: 'Golden Surfboard',  emoji: '🏄', rarity: 'legendary', currencyValue: 50 },
                { itemId: 'beach_umbrella',    name: 'Beach Umbrella',    emoji: '⛱️', rarity: 'rare',      currencyValue: 20 },
                { itemId: 'sunscreen',         name: 'Sunscreen',         emoji: '🧴', rarity: 'common',    currencyValue: 5  },
                { itemId: 'tropical_drink',    name: 'Tropical Drink',    emoji: '🍹', rarity: 'uncommon',  currencyValue: 15 },
                { itemId: 'seashell',          name: 'Seashell',          emoji: '🐚', rarity: 'common',    currencyValue: 5  },
                { itemId: 'snorkel_set',       name: 'Snorkel Set',       emoji: '🤿', rarity: 'rare',      currencyValue: 25 },
            ],
        },
        shop: [
            { itemId: 'summer_loot_box',   name: 'Summer Loot Box',   emoji: '🌊',  cost: 50,  description: 'Contains exclusive summer items' },
            { itemId: 'golden_surfboard',  name: 'Golden Surfboard',  emoji: '🏄',  cost: 300, description: 'Legendary summer collectible' },
            { itemId: 'xp_booster_2x',     name: '2x XP Booster',     emoji: '⭐🚀', cost: 80,  description: '2x XP for 1 hour' },
            { itemId: 'salary_raise',      name: 'Salary Raise',      emoji: '📈',  cost: 100, description: '+50% work earnings for 2 hours' },
        ],
    },

    valentines_day: {
        id: 'valentines_day',
        name: "Valentine's Day",
        emoji: '💝',
        description: "Send gifts and spread the love! Heart-themed items and exclusive collectibles.",
        color: '#ff69b4',
        currency: { id: 'hearts', name: 'Hearts', emoji: '💝' },
        xpMultiplier: 1.0,
        coinMultiplier: 1.0,
        // Month range: February days 7-14
        autoStart: { month: 2, dayStart: 7, dayEnd: 14 },
        lootBox: {
            itemId: 'valentines_loot_box',
            name: "Valentine's Loot Box",
            emoji: '💝',
            items: [
                { itemId: 'golden_rose',     name: 'Golden Rose',     emoji: '🌹', rarity: 'legendary', currencyValue: 50 },
                { itemId: 'heart_locket',    name: 'Heart Locket',    emoji: '💗', rarity: 'rare',      currencyValue: 20 },
                { itemId: 'chocolate_box',   name: 'Chocolate Box',   emoji: '🍫', rarity: 'common',    currencyValue: 5  },
                { itemId: 'love_letter',     name: 'Love Letter',     emoji: '💌', rarity: 'uncommon',  currencyValue: 15 },
                { itemId: 'cupids_arrow',    name: "Cupid's Arrow",   emoji: '🏹', rarity: 'rare',      currencyValue: 25 },
                { itemId: 'flower_bouquet',  name: 'Flower Bouquet',  emoji: '💐', rarity: 'common',    currencyValue: 5  },
            ],
        },
        shop: [
            { itemId: 'valentines_loot_box', name: "Valentine's Loot Box", emoji: '💝',  cost: 50,  description: 'Contains romantic exclusive items' },
            { itemId: 'golden_rose',         name: 'Golden Rose',         emoji: '🌹',  cost: 300, description: 'Legendary Valentine collectible' },
            { itemId: 'lucky_streak',        name: 'Lucky Streak',        emoji: '🎯',  cost: 70,  description: '+25% win rate for 30 min' },
            { itemId: 'coin_booster_2x',     name: '2x Coin Booster',     emoji: '💰🚀', cost: 80,  description: '2x coins for 1 hour' },
        ],
    },
};

const RARITY_WEIGHTS = {
    common:    60,
    uncommon:  25,
    rare:      12,
    legendary:  3,
};

const RARITY_COLORS = {
    common:    '#aaaaaa',
    uncommon:  '#2ecc71',
    rare:      '#3498db',
    legendary: '#f1c40f',
};

function getActiveSeasonalEvent() {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();

    for (const event of Object.values(SEASONAL_EVENTS)) {
        const { autoStart } = event;
        if (!autoStart) continue;
        if (month === autoStart.month && day >= autoStart.dayStart && day <= autoStart.dayEnd) {
            return event;
        }
    }
    return null;
}

function rollLootBox(eventDef) {
    const items = eventDef.lootBox?.items;
    if (!items?.length) return null;

    const pool = [];
    for (const item of items) {
        const weight = RARITY_WEIGHTS[item.rarity] ?? 10;
        for (let i = 0; i < weight; i++) pool.push(item);
    }

    return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
    SEASONAL_EVENTS,
    RARITY_WEIGHTS,
    RARITY_COLORS,
    getActiveSeasonalEvent,
    rollLootBox,
};
