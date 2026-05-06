'use strict';

// ─── ROD TIERS ────────────────────────────────────────────────────────────────

const ROD_TIERS = [
    {
        tier: 1, slug: 'bamboo_rod', name: 'Bamboo Rod', emoji: '🎋',
        cost: 500, baseDurability: 80, successRate: 0.50, rarityBoost: 0.00,
        requiresBait: false, baitType: null, baitCost: 0,
        repairCostPer20: 70,
        description: 'A simple bamboo rod. No bait required — just patience.'
    },
    {
        tier: 2, slug: 'fiberglass_rod', name: 'Fiberglass Rod', emoji: '🪝',
        cost: 2500, baseDurability: 110, successRate: 0.62, rarityBoost: 0.02,
        requiresBait: true, baitType: 'worm_bait', baitCost: 4,
        repairCostPer20: 160,
        description: 'A reliable fiberglass rod. Uses Worm Bait per cast.'
    },
    {
        tier: 3, slug: 'carbon_rod', name: 'Carbon Fiber Rod', emoji: '🔱',
        cost: 8000, baseDurability: 150, successRate: 0.72, rarityBoost: 0.05,
        requiresBait: true, baitType: 'shrimp_bait', baitCost: 8,
        repairCostPer20: 380,
        description: 'A precision carbon rod. Uses Shrimp Bait per cast.'
    },
    {
        tier: 4, slug: 'titanium_rod', name: 'Titanium Rod', emoji: '⚙️',
        cost: 28000, baseDurability: 190, successRate: 0.80, rarityBoost: 0.09,
        requiresBait: true, baitType: 'lure', baitCost: 12,
        repairCostPer20: 860,
        description: 'A high-end titanium rod. Uses Lure per cast.'
    },
    {
        tier: 5, slug: 'crystal_rod', name: 'Crystal Rod', emoji: '💎',
        cost: 90000, baseDurability: 240, successRate: 0.87, rarityBoost: 0.14,
        requiresBait: true, baitType: 'enchanted_lure', baitCost: 18,
        repairCostPer20: 1800,
        description: 'A legendary crystal rod. Uses Enchanted Lure per cast.'
    }
];

const ROD_BY_SLUG = Object.fromEntries(ROD_TIERS.map(r => [r.slug, r]));
const ROD_BY_TIER = Object.fromEntries(ROD_TIERS.map(r => [r.tier, r]));

// ─── ROD UPGRADES ─────────────────────────────────────────────────────────────

const ROD_UPGRADES = {
    enhanced_line: {
        id: 'enhanced_line', name: 'Enhanced Line', emoji: '🪡',
        costMultiplier: 0.30,
        effect: { successBonus: 0.04 },
        description: '+4% catch success chance'
    },
    polarized_lens: {
        id: 'polarized_lens', name: 'Polarized Lens', emoji: '🔭',
        costMultiplier: 0.30,
        effect: { rarityBonus: 0.03 },
        description: '+3% rarity boost on catch tier'
    },
    reinforced_grip: {
        id: 'reinforced_grip', name: 'Reinforced Grip', emoji: '🛡️',
        costMultiplier: 0.25,
        effect: { durabilityReduction: 1 },
        description: 'Reduces durability loss by 1 per cast (minimum 1)'
    }
};

// ─── BAIT PACKS ───────────────────────────────────────────────────────────────

const BAIT_PACKS = [
    {
        id: 'worm_bait_pack', name: 'Worm Bait (20)', emoji: '🪱',
        cost: 70, baitType: 'worm_bait', quantity: 20,
        description: 'Bait for Fiberglass Rod'
    },
    {
        id: 'shrimp_bait_pack', name: 'Shrimp Bait (20)', emoji: '🦐',
        cost: 140, baitType: 'shrimp_bait', quantity: 20,
        description: 'Bait for Carbon Fiber Rod'
    },
    {
        id: 'lure_pack', name: 'Lure (20)', emoji: '🎣',
        cost: 210, baitType: 'lure', quantity: 20,
        description: 'Bait for Titanium Rod'
    },
    {
        id: 'enchanted_lure_pack', name: 'Enchanted Lure (20)', emoji: '✨',
        cost: 320, baitType: 'enchanted_lure', quantity: 20,
        description: 'Bait for Crystal Rod'
    }
];

// ─── CONSUMABLES ─────────────────────────────────────────────────────────────

const CONSUMABLES = {
    chum_bait: {
        id: 'chum_bait', name: 'Chum Bait', emoji: '🐟',
        cost: 70, type: 'bait', castsLeft: 3,
        effect: { tierShift: 0.08 },
        description: '+8% rare tier chance for 3 casts',
        maxStack: 10
    },
    premium_chum: {
        id: 'premium_chum', name: 'Premium Chum', emoji: '🦐',
        cost: 240, type: 'bait', castsLeft: 3,
        effect: { tierShift: 0.15, epicShift: 0.05 },
        description: '+15% rare, +5% epic chance for 3 casts',
        maxStack: 5
    },
    anglers_luck: {
        id: 'anglers_luck', name: "Angler's Luck", emoji: '🍀',
        cost: 55, type: 'instant', castsLeft: 1,
        effect: { successBonus: 0.10 },
        description: '+10% catch success for 1 cast',
        maxStack: 10
    },
    fish_xp_scroll: {
        id: 'fish_xp_scroll', name: 'XP Scroll', emoji: '📜',
        cost: 175, type: 'instant', castsLeft: 1,
        effect: { xpMultiplier: 0.50 },
        description: '+50% fishing XP on next cast',
        maxStack: 10
    },
    repair_kit_small: {
        id: 'repair_kit_small', name: 'Repair Kit (Small)', emoji: '🔧',
        cost: 110, type: 'repair', durabilityRestore: 20,
        description: 'Restores 20 durability to equipped rod',
        maxStack: 5
    },
    repair_kit_large: {
        id: 'repair_kit_large', name: 'Repair Kit (Large)', emoji: '🔨',
        cost: 260, type: 'repair', durabilityRestore: 50,
        description: 'Restores 50 durability to equipped rod',
        maxStack: 3
    },
    energy_drink: {
        id: 'energy_drink', name: 'Energy Drink', emoji: '⚡',
        cost: 185, type: 'stamina', staminaRestore: 3,
        description: 'Restores 3 stamina (max 2 uses per day)',
        maxStack: 5
    }
};

// ─── LOCATIONS ────────────────────────────────────────────────────────────────

const LOCATIONS = {
    pond: {
        id: 'pond', name: 'Quiet Pond', emoji: '🌿',
        unlockLevel: 1, unlockCost: 0, defaultUnlocked: true,
        difficultyMod: 0.00, payoutBonus: 0.00,
        tierWeights: { common: 55, uncommon: 27, rare: 11, epic: 5, legendary: 1.5, event: 0.5 },
        junkChance: 0.15, treasureChance: 0.03,
        description: 'A peaceful starter pond. Calm waters, plenty of basics.'
    },
    river: {
        id: 'river', name: 'Rushing River', emoji: '🏞️',
        unlockLevel: 10, unlockCost: 2500, defaultUnlocked: false,
        difficultyMod: -0.04, payoutBonus: 0.00,
        tierWeights: { common: 44, uncommon: 31, rare: 16, epic: 7, legendary: 2, event: 0 },
        junkChance: 0.12, treasureChance: 0.04,
        description: 'Fast-flowing river with greater variety of fish.'
    },
    lake: {
        id: 'lake', name: 'Misty Lake', emoji: '🏔️',
        unlockLevel: 20, unlockCost: 10000, defaultUnlocked: false,
        difficultyMod: -0.07, payoutBonus: 0.00,
        tierWeights: { common: 37, uncommon: 29, rare: 20, epic: 10, legendary: 3, event: 1 },
        junkChance: 0.10, treasureChance: 0.05,
        description: 'A vast misty lake hiding uncommon and rare fish.'
    },
    ocean: {
        id: 'ocean', name: 'Open Ocean', emoji: '🌊',
        unlockLevel: 30, unlockCost: 28000, defaultUnlocked: false,
        difficultyMod: -0.09, payoutBonus: 0.00,
        tierWeights: { common: 30, uncommon: 27, rare: 23, epic: 14, legendary: 5, event: 1 },
        junkChance: 0.08, treasureChance: 0.07,
        description: 'The open ocean: vast, rewarding, and unforgiving.'
    },
    deep_sea: {
        id: 'deep_sea', name: 'The Abyss', emoji: '🌑',
        unlockLevel: 50, unlockCost: 70000, defaultUnlocked: false,
        difficultyMod: -0.11, payoutBonus: 0.20,
        tierWeights: { common: 15, uncommon: 21, rare: 28, epic: 22, legendary: 13, event: 1 },
        junkChance: 0.05, treasureChance: 0.10,
        description: 'The crushing depths of the Abyss. Legendary creatures lurk here.'
    }
};

const LOCATION_LIST = Object.values(LOCATIONS);

// ─── FISH ─────────────────────────────────────────────────────────────────────
// locations: ['all'] = available everywhere; otherwise specific location ids.

const FISH = {
    // ── COMMON ───────────────────────────────────────────────────────────────
    minnow: {
        id: 'minnow', name: 'Minnow', emoji: '🐟', tier: 'common',
        payoutMin: 8, payoutMax: 20, xp: 8,
        specialDrop: { itemId: 'fish_scale', name: 'Fish Scale', chance: 0.04 },
        locations: ['all'],
        sizeVariance: true,
        flavor: 'A tiny minnow barely big enough to see.'
    },
    perch: {
        id: 'perch', name: 'Perch', emoji: '🐟', tier: 'common',
        payoutMin: 15, payoutMax: 32, xp: 10,
        specialDrop: { itemId: 'fish_scale', name: 'Fish Scale', chance: 0.05 },
        locations: ['pond', 'river', 'lake'],
        sizeVariance: true,
        flavor: 'A striped perch with vibrant yellow fins.'
    },
    catfish: {
        id: 'catfish', name: 'Catfish', emoji: '🐱', tier: 'common',
        payoutMin: 20, payoutMax: 42, xp: 10,
        specialDrop: null,
        locations: ['pond', 'river', 'lake'],
        sizeVariance: true,
        flavor: 'A whiskered catfish wallowing in the murky bottom.'
    },
    bluegill: {
        id: 'bluegill', name: 'Bluegill', emoji: '🔵', tier: 'common',
        payoutMin: 18, payoutMax: 36, xp: 10,
        specialDrop: { itemId: 'fish_scale', name: 'Fish Scale', chance: 0.04 },
        locations: ['pond', 'lake'],
        sizeVariance: true,
        flavor: 'A plump bluegill sunning itself near the surface.'
    },
    carp: {
        id: 'carp', name: 'Carp', emoji: '🐠', tier: 'common',
        payoutMin: 22, payoutMax: 48, xp: 10,
        specialDrop: null,
        locations: ['pond', 'river', 'lake'],
        sizeVariance: true,
        flavor: 'A golden carp leisurely swimming through the reeds.'
    },
    tilapia: {
        id: 'tilapia', name: 'Tilapia', emoji: '🐟', tier: 'common',
        payoutMin: 24, payoutMax: 50, xp: 10,
        specialDrop: null,
        locations: ['pond', 'river'],
        sizeVariance: true,
        flavor: 'A steady-swimming tilapia, a staple of calm waters.'
    },
    mudfish: {
        id: 'mudfish', name: 'Mudfish', emoji: '🟤', tier: 'common',
        payoutMin: 12, payoutMax: 28, xp: 8,
        specialDrop: { itemId: 'seaweed_bundle', name: 'Seaweed Bundle', chance: 0.06 },
        locations: ['pond', 'lake'],
        sizeVariance: false,
        flavor: 'A mudfish dragged up from the silty depths.'
    },
    herring: {
        id: 'herring', name: 'Herring', emoji: '🐟', tier: 'common',
        payoutMin: 18, payoutMax: 38, xp: 10,
        specialDrop: null,
        locations: ['ocean', 'river'],
        sizeVariance: true,
        flavor: 'A silver herring darting in tight formations.'
    },

    // ── UNCOMMON ────────────────────────────────────────────────────────────
    bass: {
        id: 'bass', name: 'Largemouth Bass', emoji: '🐟', tier: 'uncommon',
        payoutMin: 55, payoutMax: 112, xp: 25,
        specialDrop: { itemId: 'fish_scale', name: 'Fish Scale', chance: 0.08 },
        locations: ['pond', 'river', 'lake'],
        sizeVariance: true,
        flavor: 'A largemouth bass erupts from the water in a spectacular leap.'
    },
    trout: {
        id: 'trout', name: 'Rainbow Trout', emoji: '🎏', tier: 'uncommon',
        payoutMin: 65, payoutMax: 120, xp: 25,
        specialDrop: { itemId: 'rare_scale', name: 'Rare Scale', chance: 0.04 },
        locations: ['river', 'lake'],
        sizeVariance: true,
        flavor: 'A rainbow trout explodes from the rapids, scales glittering.'
    },
    pike: {
        id: 'pike', name: 'Northern Pike', emoji: '🗡️', tier: 'uncommon',
        payoutMin: 60, payoutMax: 115, xp: 25,
        specialDrop: null,
        locations: ['lake', 'river'],
        sizeVariance: true,
        flavor: 'A toothy northern pike lurking beneath the lily pads.'
    },
    flounder: {
        id: 'flounder', name: 'Flounder', emoji: '🫓', tier: 'uncommon',
        payoutMin: 55, payoutMax: 108, xp: 25,
        specialDrop: { itemId: 'driftwood', name: 'Driftwood', chance: 0.05 },
        locations: ['ocean'],
        sizeVariance: true,
        flavor: 'A flat flounder camouflaged perfectly against the sandy sea floor.'
    },
    snapper: {
        id: 'snapper', name: 'Red Snapper', emoji: '🔴', tier: 'uncommon',
        payoutMin: 70, payoutMax: 132, xp: 25,
        specialDrop: null,
        locations: ['ocean', 'lake'],
        sizeVariance: true,
        flavor: 'A vivid red snapper, prized by anglers and chefs alike.'
    },
    mackerel: {
        id: 'mackerel', name: 'Mackerel', emoji: '🐟', tier: 'uncommon',
        payoutMin: 60, payoutMax: 118, xp: 25,
        specialDrop: { itemId: 'fish_scale', name: 'Fish Scale', chance: 0.07 },
        locations: ['ocean', 'river'],
        sizeVariance: true,
        flavor: 'A sleek mackerel zipping through the current.'
    },

    // ── RARE ────────────────────────────────────────────────────────────────
    salmon: {
        id: 'salmon', name: 'King Salmon', emoji: '🐡', tier: 'rare',
        payoutMin: 130, payoutMax: 235, xp: 75,
        specialDrop: { itemId: 'rare_scale', name: 'Rare Scale', chance: 0.10 },
        locations: ['river', 'lake', 'ocean'],
        sizeVariance: true,
        flavor: 'A mighty king salmon fighting its way upstream.'
    },
    tuna: {
        id: 'tuna', name: 'Bluefin Tuna', emoji: '🐋', tier: 'rare',
        payoutMin: 160, payoutMax: 285, xp: 75,
        specialDrop: { itemId: 'rare_scale', name: 'Rare Scale', chance: 0.09 },
        locations: ['ocean', 'deep_sea'],
        sizeVariance: true,
        flavor: 'A bluefin tuna surging through the deep blue at full sprint.'
    },
    swordfish: {
        id: 'swordfish', name: 'Swordfish', emoji: '⚔️', tier: 'rare',
        payoutMin: 150, payoutMax: 258, xp: 75,
        specialDrop: { itemId: 'driftwood', name: 'Driftwood', chance: 0.08 },
        locations: ['ocean', 'deep_sea'],
        sizeVariance: true,
        flavor: 'A swordfish breaches the surface, its bill gleaming like steel.'
    },
    barracuda: {
        id: 'barracuda', name: 'Barracuda', emoji: '🦷', tier: 'rare',
        payoutMin: 140, payoutMax: 245, xp: 75,
        specialDrop: null,
        locations: ['ocean'],
        sizeVariance: true,
        flavor: 'A barracuda snaps at your lure with razor teeth.'
    },
    grouper: {
        id: 'grouper', name: 'Giant Grouper', emoji: '🐡', tier: 'rare',
        payoutMin: 145, payoutMax: 252, xp: 75,
        specialDrop: { itemId: 'old_coin', name: 'Old Coin', chance: 0.06 },
        locations: ['ocean', 'lake'],
        sizeVariance: true,
        flavor: 'A massive grouper emerges from its coral cave.'
    },

    // ── EPIC ────────────────────────────────────────────────────────────────
    marlin: {
        id: 'marlin', name: 'Blue Marlin', emoji: '🗡️', tier: 'epic',
        payoutMin: 300, payoutMax: 510, xp: 150,
        specialDrop: { itemId: 'rare_scale', name: 'Rare Scale', chance: 0.15 },
        locations: ['ocean', 'deep_sea'],
        sizeVariance: true,
        flavor: 'A blue marlin launches itself skyward in a display of raw power.'
    },
    giant_squid: {
        id: 'giant_squid', name: 'Giant Squid', emoji: '🦑', tier: 'epic',
        payoutMin: 320, payoutMax: 530, xp: 150,
        specialDrop: { itemId: 'tentacle_ink', name: 'Tentacle Ink', chance: 0.12 },
        locations: ['deep_sea'],
        sizeVariance: false,
        flavor: 'Enormous tentacles coil around your line as the giant squid surfaces!'
    },
    oarfish: {
        id: 'oarfish', name: 'Oarfish', emoji: '🐍', tier: 'epic',
        payoutMin: 350, payoutMax: 560, xp: 150,
        specialDrop: { itemId: 'rare_scale', name: 'Rare Scale', chance: 0.14 },
        locations: ['deep_sea', 'ocean'],
        sizeVariance: true,
        flavor: 'The legendary oarfish, thirty feet long, ribbons through the dark water.'
    },
    hammerhead: {
        id: 'hammerhead', name: 'Hammerhead Shark', emoji: '🦈', tier: 'epic',
        payoutMin: 280, payoutMax: 480, xp: 150,
        specialDrop: { itemId: 'shark_tooth', name: 'Shark Tooth', chance: 0.15 },
        locations: ['ocean', 'deep_sea'],
        sizeVariance: true,
        flavor: 'A hammerhead shark circles once before exploding after your lure.'
    },

    // ── LEGENDARY ────────────────────────────────────────────────────────────
    great_white: {
        id: 'great_white', name: 'Great White Shark', emoji: '🦈', tier: 'legendary',
        payoutMin: 700, payoutMax: 1200, xp: 500,
        specialDrop: { itemId: 'shark_tooth', name: 'Shark Tooth', chance: 0.25 },
        locations: ['ocean', 'deep_sea'],
        sizeVariance: true,
        flavor: 'The apex predator of the ocean tears through the surface with terrifying force.'
    },
    whale: {
        id: 'whale', name: 'Blue Whale', emoji: '🐳', tier: 'legendary',
        payoutMin: 900, payoutMax: 1400, xp: 500,
        specialDrop: { itemId: 'mythic_scale', name: 'Mythic Scale', chance: 0.20 },
        locations: ['deep_sea'],
        sizeVariance: false,
        flavor: 'The ocean trembles as an immense blue whale breaches beside your boat.'
    },
    kraken: {
        id: 'kraken', name: 'Kraken Tentacle', emoji: '🐙', tier: 'legendary',
        payoutMin: 800, payoutMax: 1350, xp: 500,
        specialDrop: { itemId: 'tentacle_ink', name: 'Tentacle Ink', chance: 0.30 },
        locations: ['deep_sea'],
        sizeVariance: false,
        flavor: 'A single enormous tentacle rises from the abyss. The Kraken stirs.'
    },

    // ── EVENT / MYTHICAL ─────────────────────────────────────────────────────
    sea_dragon: {
        id: 'sea_dragon', name: 'Sea Dragon', emoji: '🐲', tier: 'event',
        payoutMin: 1900, payoutMax: 3100, xp: 1000,
        specialDrop: { itemId: 'mythic_scale', name: 'Mythic Scale', chance: 0.35 },
        locations: ['all'],
        sizeVariance: false,
        flavor: 'Impossibly ancient, a luminescent sea dragon coils around your line!'
    },
    leviathan: {
        id: 'leviathan', name: 'Leviathan', emoji: '🌊', tier: 'event',
        payoutMin: 2200, payoutMax: 3600, xp: 1000,
        specialDrop: { itemId: 'mythic_scale', name: 'Mythic Scale', chance: 0.40 },
        locations: ['deep_sea'],
        sizeVariance: false,
        flavor: 'The ocean itself seems to recoil as the Leviathan awakens from its slumber.'
    },
    ghost_fish: {
        id: 'ghost_fish', name: 'Ghost Fish', emoji: '👻', tier: 'event',
        payoutMin: 1700, payoutMax: 2800, xp: 1000,
        specialDrop: { itemId: 'pearl', name: 'Ghost Pearl', chance: 0.45 },
        locations: ['all'],
        sizeVariance: false,
        flavor: 'A translucent spectral fish phases in and out of reality before your eyes.'
    }
};

// Fish indexed by tier
const FISH_BY_TIER = {};
for (const fish of Object.values(FISH)) {
    if (!FISH_BY_TIER[fish.tier]) FISH_BY_TIER[fish.tier] = [];
    FISH_BY_TIER[fish.tier].push(fish);
}

// ─── JUNK ITEMS ───────────────────────────────────────────────────────────────

const JUNK_ITEMS = [
    { id: 'old_boot',     name: 'Old Boot',     emoji: '👢', payoutMin: 0,  payoutMax: 0,  weight: 25 },
    { id: 'tin_can',      name: 'Tin Can',       emoji: '🥫', payoutMin: 0,  payoutMax: 0,  weight: 20 },
    { id: 'seaweed',      name: 'Seaweed',       emoji: '🌿', payoutMin: 3,  payoutMax: 8,  weight: 25 },
    { id: 'driftwood_junk', name: 'Driftwood',   emoji: '🪵', payoutMin: 5,  payoutMax: 12, weight: 20 },
    { id: 'soggy_scroll', name: 'Soggy Scroll',  emoji: '📜', payoutMin: 10, payoutMax: 22, weight: 10 }
];

// ─── TREASURE ITEMS ───────────────────────────────────────────────────────────

const TREASURE_ITEMS = [
    { id: 'sunken_chest', name: 'Sunken Chest',  emoji: '📦', payoutMin: 150, payoutMax: 320, weight: 40 },
    { id: 'ancient_coin', name: 'Ancient Coin',  emoji: '🪙', payoutMin: 80,  payoutMax: 165, weight: 35 },
    { id: 'pearl',        name: 'Pearl',         emoji: '🫧', payoutMin: 100, payoutMax: 210, weight: 18 },
    { id: 'coral_gem',    name: 'Coral Gem',     emoji: '💎', payoutMin: 200, payoutMax: 420, weight: 7  }
];

// ─── FISHER LEVELS ────────────────────────────────────────────────────────────

const FISHER_LEVELS = [
    { level: 1,  xpRequired: 0,      title: 'Novice Fisher',    unlocks: [] },
    { level: 2,  xpRequired: 80,     title: 'Novice Fisher',    unlocks: [] },
    { level: 3,  xpRequired: 160,    title: 'Novice Fisher',    unlocks: [] },
    { level: 4,  xpRequired: 250,    title: 'Novice Fisher',    unlocks: [] },
    { level: 5,  xpRequired: 400,    title: 'Casual Angler',    unlocks: [] },
    { level: 6,  xpRequired: 560,    title: 'Casual Angler',    unlocks: [] },
    { level: 7,  xpRequired: 720,    title: 'Casual Angler',    unlocks: [] },
    { level: 8,  xpRequired: 900,    title: 'Casual Angler',    unlocks: [] },
    { level: 9,  xpRequired: 1080,   title: 'Casual Angler',    unlocks: [] },
    { level: 10, xpRequired: 1300,   title: 'Seasoned Angler',  unlocks: ['river'] },
    { level: 11, xpRequired: 1600,   title: 'Seasoned Angler',  unlocks: [] },
    { level: 12, xpRequired: 1900,   title: 'Seasoned Angler',  unlocks: [] },
    { level: 13, xpRequired: 2200,   title: 'Seasoned Angler',  unlocks: [] },
    { level: 14, xpRequired: 2500,   title: 'Seasoned Angler',  unlocks: [] },
    { level: 15, xpRequired: 2900,   title: 'River Angler',     unlocks: [] },
    { level: 16, xpRequired: 3500,   title: 'River Angler',     unlocks: [] },
    { level: 17, xpRequired: 4100,   title: 'River Angler',     unlocks: [] },
    { level: 18, xpRequired: 4700,   title: 'River Angler',     unlocks: [] },
    { level: 19, xpRequired: 5300,   title: 'River Angler',     unlocks: [] },
    { level: 20, xpRequired: 6000,   title: 'Lake Angler',      unlocks: ['lake'] },
    { level: 21, xpRequired: 7000,   title: 'Lake Angler',      unlocks: [] },
    { level: 22, xpRequired: 8000,   title: 'Lake Angler',      unlocks: [] },
    { level: 23, xpRequired: 9000,   title: 'Lake Angler',      unlocks: [] },
    { level: 24, xpRequired: 10000,  title: 'Lake Angler',      unlocks: [] },
    { level: 25, xpRequired: 11500,  title: 'Expert Fisher',    unlocks: [] },
    { level: 26, xpRequired: 13000,  title: 'Expert Fisher',    unlocks: [] },
    { level: 27, xpRequired: 14500,  title: 'Expert Fisher',    unlocks: [] },
    { level: 28, xpRequired: 16000,  title: 'Expert Fisher',    unlocks: [] },
    { level: 29, xpRequired: 17500,  title: 'Expert Fisher',    unlocks: [] },
    { level: 30, xpRequired: 19500,  title: 'Ocean Fisher',     unlocks: ['ocean'] },
    { level: 31, xpRequired: 21500,  title: 'Ocean Fisher',     unlocks: [] },
    { level: 32, xpRequired: 23500,  title: 'Ocean Fisher',     unlocks: [] },
    { level: 33, xpRequired: 25500,  title: 'Ocean Fisher',     unlocks: [] },
    { level: 34, xpRequired: 27500,  title: 'Ocean Fisher',     unlocks: [] },
    { level: 35, xpRequired: 30000,  title: 'Master Angler',    unlocks: [] },
    { level: 36, xpRequired: 32500,  title: 'Master Angler',    unlocks: [] },
    { level: 37, xpRequired: 35000,  title: 'Master Angler',    unlocks: [] },
    { level: 38, xpRequired: 37500,  title: 'Master Angler',    unlocks: [] },
    { level: 39, xpRequired: 40000,  title: 'Master Angler',    unlocks: [] },
    { level: 40, xpRequired: 43000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 41, xpRequired: 47000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 42, xpRequired: 51000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 43, xpRequired: 55000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 44, xpRequired: 59000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 45, xpRequired: 63000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 46, xpRequired: 67000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 47, xpRequired: 71000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 48, xpRequired: 75000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 49, xpRequired: 79000,  title: 'Deep Sea Fisher',  unlocks: [] },
    { level: 50, xpRequired: 83000,  title: 'Legendary Fisher', unlocks: ['deep_sea'] }
];

// ─── TIER DISPLAY ─────────────────────────────────────────────────────────────

const TIER_COLORS = {
    common:    '#95a5a6',
    uncommon:  '#2ecc71',
    rare:      '#3498db',
    epic:      '#9b59b6',
    legendary: '#f39c12',
    event:     '#e74c3c',
    junk:      '#7f8c8d',
    treasure:  '#f1c40f'
};

const TIER_LABELS = {
    common: 'Common', uncommon: 'Uncommon', rare: 'Rare',
    epic: 'Epic', legendary: 'Legendary', event: 'Event'
};

// ─── ANTI-EXPLOIT CONSTANTS ───────────────────────────────────────────────────

const LIMITS = {
    CAST_COOLDOWN_MS:        25_000,        // 25 seconds between casts
    INJURY_PENALTY_MS:       10 * 60_000,   // +10 min on fell-in event
    STAMINA_REGEN_MS:        6  * 60_000,   // 1 stamina per 6 minutes
    MAX_STAMINA_BASE:        10,
    DAILY_WINDOW_MS:         24 * 3_600_000,
    DAILY_SOFT_CAP:          75_000,        // 50% payout reduction above this
    DAILY_HARD_CAP:          140_000,       // 0 coins above this
    DIM_RETURNS_THRESHOLD_1: 50,            // after 50 casts/day → ×0.85
    DIM_RETURNS_THRESHOLD_2: 80,            // after 80 → ×0.70
    DIM_RETURNS_THRESHOLD_3: 110,           // after 110 → ×0.55
    MAX_CRIT_CHANCE:         0.25,
    ENERGY_DRINKS_PER_DAY:   2,
    PITY_CONSECUTIVE_FAILS:  4,
    PITY_BONUS_PER_STACK:    0.15
};

// ─── PRESTIGE BONUSES ────────────────────────────────────────────────────────

const PRESTIGE_BONUSES = [
    { prestige: 0, critBonus: 0,    staminaBonus: 0, payoutBonus: 0,    rarityBonus: 0    },
    { prestige: 1, critBonus: 0.02, staminaBonus: 0, payoutBonus: 0,    rarityBonus: 0    },
    { prestige: 2, critBonus: 0.02, staminaBonus: 1, payoutBonus: 0,    rarityBonus: 0    },
    { prestige: 3, critBonus: 0.02, staminaBonus: 1, payoutBonus: 0.05, rarityBonus: 0    },
    { prestige: 4, critBonus: 0.02, staminaBonus: 1, payoutBonus: 0.05, rarityBonus: 0.02 },
    { prestige: 5, critBonus: 0.02, staminaBonus: 1, payoutBonus: 0.10, rarityBonus: 0.02 }
];

// ─── MATERIAL NAMES ───────────────────────────────────────────────────────────

const MATERIAL_NAMES = {
    fish_scale:    'Fish Scale',
    rare_scale:    'Rare Scale',
    mythic_scale:  'Mythic Scale',
    pearl:         'Pearl',
    seaweed_bundle:'Seaweed Bundle',
    driftwood:     'Driftwood',
    old_coin:      'Old Coin',
    shark_tooth:   'Shark Tooth',
    tentacle_ink:  'Tentacle Ink',
    coral_fragment:'Coral Fragment'
};

// ─── CRAFTING RECIPES ─────────────────────────────────────────────────────────

const FISH_CRAFT_RECIPES = {
    chum_bait_3x: {
        id: 'chum_bait_3x', name: 'Chum Bait ×3', emoji: '🐟',
        description: 'Craft 3 Chum Bait from Fish Scales',
        ingredients: [{ material: 'fish_scale', qty: 3 }],
        output: { type: 'consumable', id: 'chum_bait', qty: 3 }
    },
    premium_chum_1x: {
        id: 'premium_chum_1x', name: 'Premium Chum ×1', emoji: '🦐',
        description: 'Craft Premium Chum from rare scales and hunt material',
        ingredients: [
            { material: 'rare_scale',   qty: 2 },
            { material: 'rabbits_foot', qty: 1, source: 'hunt' }  // cross-system!
        ],
        output: { type: 'consumable', id: 'premium_chum', qty: 1 }
    },
    anglers_luck_3x: {
        id: 'anglers_luck_3x', name: "Angler's Luck ×3", emoji: '🍀',
        description: "Craft 3 Angler's Luck from fish materials",
        ingredients: [
            { material: 'fish_scale', qty: 3 },
            { material: 'driftwood',  qty: 2 }
        ],
        output: { type: 'consumable', id: 'anglers_luck', qty: 3 }
    },
    fish_xp_scroll_1x: {
        id: 'fish_xp_scroll_1x', name: 'XP Scroll ×1', emoji: '📜',
        description: 'Craft an XP Scroll from rare materials',
        ingredients: [
            { material: 'rare_scale',   qty: 1 },
            { material: 'tentacle_ink', qty: 1 }
        ],
        output: { type: 'consumable', id: 'fish_xp_scroll', qty: 1 }
    },
    repair_kit_small_2x: {
        id: 'repair_kit_small_2x', name: 'Repair Kit (Small) ×2', emoji: '🔧',
        description: 'Craft 2 small repair kits from ocean materials',
        ingredients: [
            { material: 'seaweed_bundle', qty: 3 },
            { material: 'driftwood',      qty: 2 }
        ],
        output: { type: 'consumable', id: 'repair_kit_small', qty: 2 }
    },
    repair_kit_large_1x: {
        id: 'repair_kit_large_1x', name: 'Repair Kit (Large) ×1', emoji: '🔨',
        description: 'Craft a large repair kit from shark tooth and wood',
        ingredients: [
            { material: 'shark_tooth', qty: 1 },
            { material: 'driftwood',   qty: 3 }
        ],
        output: { type: 'consumable', id: 'repair_kit_large', qty: 1 }
    },
    lucky_hook: {
        id: 'lucky_hook', name: 'Lucky Hook', emoji: '🎣',
        description: 'A permanent upgrade granting +1% critical catch chance',
        ingredients: [
            { material: 'pearl',        qty: 3 },
            { material: 'mythic_scale', qty: 1 },
            { material: 'shark_tooth',  qty: 2 }
        ],
        output: { type: 'permanent', id: 'luckyHook' },
        unique: true
    },
    // Cross-system recipe: combine fish + hunt materials
    hunters_brew: {
        id: 'hunters_brew', name: "Hunter's Brew", emoji: '⚗️',
        description: 'Brew a combo tonic using both fish and hunt materials (restores stamina in BOTH systems)',
        ingredients: [
            { material: 'tentacle_ink', qty: 1 },
            { material: 'feather',      qty: 2, source: 'hunt' },
            { material: 'rare_scale',   qty: 1 }
        ],
        output: { type: 'dual_stamina', qty: 2 },
        unique: false
    }
};

// ─── FISHING DAILY QUEST TEMPLATES ───────────────────────────────────────────

const FISH_QUEST_TEMPLATES = [
    {
        id: 'fq_cast5',    name: 'First Catch',       emoji: '🎣',
        description: 'Complete 5 fishing casts',
        type: 'total_casts', target: 5,
        reward: { coins: 180, xp: 40 }, minLevel: 1
    },
    {
        id: 'fq_cast15',   name: 'Dedicated Angler',  emoji: '🏅',
        description: 'Complete 15 fishing casts',
        type: 'total_casts', target: 15,
        reward: { coins: 450, xp: 120 }, minLevel: 1
    },
    {
        id: 'fq_rare3',    name: 'Trophy Fisherman',  emoji: '⭐',
        description: 'Catch 3 rare (or better) fish',
        type: 'rare_plus_catches', target: 3,
        reward: { coins: 280, xp: 90 }, minLevel: 1
    },
    {
        id: 'fq_epic2',    name: 'Deep Dive',         emoji: '💜',
        description: 'Catch 2 epic fish',
        type: 'epic_plus_catches', target: 2,
        reward: { coins: 580, xp: 180 }, minLevel: 15
    },
    {
        id: 'fq_leg1',     name: 'Legend of the Sea', emoji: '✨',
        description: 'Catch 1 legendary fish',
        type: 'legendary_plus_catches', target: 1,
        reward: { coins: 950, xp: 280 }, minLevel: 25
    },
    {
        id: 'fq_crit5',    name: 'Perfect Cast',      emoji: '🎯',
        description: 'Land 5 critical catches',
        type: 'crits', target: 5,
        reward: { coins: 320, xp: 90 }, minLevel: 1
    },
    {
        id: 'fq_earn1k',   name: 'Bounty Haul',       emoji: '💰',
        description: 'Earn 1,000 coins from fishing',
        type: 'earn_coins', target: 1000,
        reward: { coins: 230, xp: 65 }, minLevel: 1
    },
    {
        id: 'fq_earn5k',   name: 'Big Catch Day',     emoji: '💸',
        description: 'Earn 5,000 coins from fishing',
        type: 'earn_coins', target: 5000,
        reward: { coins: 750, xp: 180 }, minLevel: 10
    },
    {
        id: 'fq_mat3',     name: 'Collector',         emoji: '🪨',
        description: 'Collect 3 material drops',
        type: 'material_drops', target: 3,
        reward: { coins: 360, xp: 110 }, minLevel: 1
    },
    {
        id: 'fq_streak5',  name: 'On a Roll',         emoji: '🔥',
        description: 'Land 5 consecutive successful casts',
        type: 'success_streak', target: 5,
        reward: { coins: 420, xp: 130 }, minLevel: 1
    },
    {
        id: 'fq_treasure2', name: 'Sunken Treasure',  emoji: '📦',
        description: 'Pull up 2 treasure items',
        type: 'treasure_pulls', target: 2,
        reward: { coins: 300, xp: 100 }, minLevel: 1
    },
    {
        id: 'fq_river5',   name: 'River Run',         emoji: '🏞️',
        description: 'Fish 5 times at the Rushing River',
        type: 'location_casts', location: 'river', target: 5,
        reward: { coins: 280, xp: 90 }, minLevel: 10
    },
    {
        id: 'fq_lake5',    name: 'Lake Loop',         emoji: '🏔️',
        description: 'Fish 5 times at the Misty Lake',
        type: 'location_casts', location: 'lake', target: 5,
        reward: { coins: 480, xp: 140 }, minLevel: 20
    },
    {
        id: 'fq_ocean5',   name: 'Ocean Expedition',  emoji: '🌊',
        description: 'Fish 5 times at the Open Ocean',
        type: 'location_casts', location: 'ocean', target: 5,
        reward: { coins: 680, xp: 190 }, minLevel: 30
    },
    {
        id: 'fq_abyss5',   name: 'Into the Abyss',   emoji: '🌑',
        description: 'Fish 5 times in The Abyss',
        type: 'location_casts', location: 'deep_sea', target: 5,
        reward: { coins: 1100, xp: 320 }, minLevel: 50
    }
];

// ─── FAILURE SEVERITIES ───────────────────────────────────────────────────────

const FAILURE_SEVERITIES = [
    { id: 'line_slack',   label: 'Line Slack',    durLoss: 1, injuryMs: 0, xp: 0,
      msg: 'Your line went slack. The fish slipped away.' },
    { id: 'line_slack',   label: 'Line Slack',    durLoss: 1, injuryMs: 0, xp: 0,
      msg: 'Nothing on the hook. Better luck next cast.' },
    { id: 'spooked',      label: 'Spooked',       durLoss: 2, injuryMs: 0, xp: 3,
      msg: 'Something spooked the fish before you could reel it in.' },
    { id: 'spooked',      label: 'Spooked',       durLoss: 2, injuryMs: 0, xp: 3,
      msg: 'A shadow on the water sent the fish diving.' },
    { id: 'line_snap',    label: 'Line Snapped',  durLoss: 4, injuryMs: 0, xp: 0,
      msg: 'Your line snapped under the strain! The fish escaped.' },
    { id: 'fell_in',      label: 'Fell In!',      durLoss: 5, injuryMs: LIMITS.INJURY_PENALTY_MS, xp: 0,
      msg: 'You slipped on the bank and fell in! You need a moment to dry off.' }
];

module.exports = {
    ROD_TIERS,
    ROD_BY_SLUG,
    ROD_BY_TIER,
    ROD_UPGRADES,
    BAIT_PACKS,
    CONSUMABLES,
    LOCATIONS,
    LOCATION_LIST,
    FISH,
    FISH_BY_TIER,
    JUNK_ITEMS,
    TREASURE_ITEMS,
    FISHER_LEVELS,
    TIER_COLORS,
    TIER_LABELS,
    LIMITS,
    PRESTIGE_BONUSES,
    MATERIAL_NAMES,
    FISH_CRAFT_RECIPES,
    FISH_QUEST_TEMPLATES,
    FAILURE_SEVERITIES
};
