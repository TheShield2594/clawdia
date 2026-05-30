'use strict';

// Featured rotation options for each activity category.
// Items are chosen deterministically per guild+date so all guild members see the same featured items.

const FEATURED_CRIMES = [
    { name: 'pickpocketing',      displayName: 'Quick Snatch',  emoji: '🤏' },
    { name: 'selling fake merch', displayName: 'Street Hustle', emoji: '🛍️' },
    { name: 'hacking ATMs',       displayName: 'ATM Ghost',     emoji: '💻' },
    { name: 'art forgery',        displayName: 'The Forgery',   emoji: '🖼️' },
    { name: 'casino cheating',    displayName: 'Casino Con',    emoji: '🎰' },
    { name: 'grand larceny',      displayName: 'The Score',     emoji: '💎' },
];

const FEATURED_HUNT_ZONES = [
    { id: 'beginner_forest', name: 'Beginner Forest', emoji: '🌲' },
    { id: 'desert_wastes',   name: 'Desert Wastes',   emoji: '🏜️' },
    { id: 'arctic_tundra',   name: 'Arctic Tundra',   emoji: '🏔️' },
    { id: 'murky_swamp',     name: 'Murky Swamp',     emoji: '🌿' },
    { id: 'legendary_peaks', name: 'Legendary Peaks', emoji: '⛰️' },
];

const FEATURED_FISH_SPOTS = [
    { id: 'pond',     name: 'Quiet Pond',    emoji: '🌿' },
    { id: 'river',    name: 'Rushing River', emoji: '🏞️' },
    { id: 'lake',     name: 'Misty Lake',    emoji: '🏔️' },
    { id: 'ocean',    name: 'Open Ocean',    emoji: '🌊' },
    { id: 'deep_sea', name: 'The Abyss',     emoji: '🌑' },
];

const FEATURED_MINE_DEPTHS = [
    { id: 'surface_quarry', name: 'Surface Quarry', emoji: '🪨' },
    { id: 'coal_tunnels',   name: 'Coal Tunnels',   emoji: '🖤' },
    { id: 'iron_mines',     name: 'Iron Mines',     emoji: '🔩' },
    { id: 'crystal_caves',  name: 'Crystal Caves',  emoji: '💠' },
    { id: 'the_abyss',      name: 'The Abyss',      emoji: '🌑' },
];

const FEATURED_PAYOUT_BONUS = 0.25;   // +25% payout when using featured option
const FEATURED_RARE_BONUS   = 0.10;   // +10% rare chance when using featured option

// FNV-1a 32-bit hash for deterministic seeded selection
function fnvHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

function seededPick(list, seed) {
    return list[fnvHash(seed) % list.length];
}

function getUTCDateString() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getDailyFeatured(guildId) {
    const date = getUTCDateString();
    const seed = `${date}:${guildId}`;
    return {
        date,
        crime:     seededPick(FEATURED_CRIMES,      seed + ':crime'),
        huntZone:  seededPick(FEATURED_HUNT_ZONES,   seed + ':hunt'),
        fishSpot:  seededPick(FEATURED_FISH_SPOTS,   seed + ':fish'),
        mineDepth: seededPick(FEATURED_MINE_DEPTHS,  seed + ':mine'),
        payoutBonus: FEATURED_PAYOUT_BONUS,
        rareBonus:   FEATURED_RARE_BONUS,
    };
}

module.exports = {
    FEATURED_CRIMES,
    FEATURED_HUNT_ZONES,
    FEATURED_FISH_SPOTS,
    FEATURED_MINE_DEPTHS,
    FEATURED_PAYOUT_BONUS,
    FEATURED_RARE_BONUS,
    getDailyFeatured,
    getUTCDateString,
};
