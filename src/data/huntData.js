'use strict';

// ─── WEAPON TIERS ────────────────────────────────────────────────────────────

const WEAPON_TIERS = [
    {
        tier: 1, slug: 'wooden_rifle', name: 'Wooden Rifle', emoji: '🪵',
        cost: 500, baseDurability: 80, successRate: 0.45, rarityBoost: 0.00,
        requiresAmmo: false, ammoType: null, ammoCost: 0,
        repairCostPer20: 80,
        description: 'A crude but reliable starter rifle. No ammo required.'
    },
    {
        tier: 2, slug: 'iron_rifle', name: 'Iron Rifle', emoji: '🔫',
        cost: 2500, baseDurability: 120, successRate: 0.56, rarityBoost: 0.02,
        requiresAmmo: true, ammoType: 'iron_shot', ammoCost: 5,
        repairCostPer20: 180,
        description: 'A solid iron rifle with better accuracy and range.'
    },
    {
        tier: 3, slug: 'steel_rifle', name: 'Steel Rifle', emoji: '🔫',
        cost: 8000, baseDurability: 160, successRate: 0.65, rarityBoost: 0.05,
        requiresAmmo: true, ammoType: 'steel_shot', ammoCost: 10,
        repairCostPer20: 400,
        description: 'A precision steel rifle for serious hunters.'
    },
    {
        tier: 4, slug: 'composite_rifle', name: 'Composite Rifle', emoji: '🔫',
        cost: 28000, baseDurability: 200, successRate: 0.74, rarityBoost: 0.09,
        requiresAmmo: true, ammoType: 'composite_round', ammoCost: 15,
        repairCostPer20: 900,
        description: 'Military-grade composite rifle for elite hunters.'
    },
    {
        tier: 5, slug: 'titanium_rifle', name: 'Titanium Rifle', emoji: '✨',
        cost: 90000, baseDurability: 250, successRate: 0.80, rarityBoost: 0.14,
        requiresAmmo: true, ammoType: 'titanium_round', ammoCost: 20,
        repairCostPer20: 2000,
        description: 'The pinnacle of hunting weaponry. Near-mythical accuracy.'
    }
];

// Keyed lookup by slug
const WEAPON_BY_SLUG = Object.fromEntries(WEAPON_TIERS.map(w => [w.slug, w]));
const WEAPON_BY_TIER = Object.fromEntries(WEAPON_TIERS.map(w => [w.tier, w]));

// ─── WEAPON UPGRADES ─────────────────────────────────────────────────────────

const WEAPON_UPGRADES = {
    rifled_barrel: {
        id: 'rifled_barrel', name: 'Rifled Barrel', emoji: '🔩',
        costMultiplier: 0.30,
        effect: { successBonus: 0.04 },
        description: '+4% success chance'
    },
    scope: {
        id: 'scope', name: 'Scope', emoji: '🔭',
        costMultiplier: 0.30,
        effect: { rarityBonus: 0.03 },
        description: '+3% rarity boost'
    },
    reinforced_stock: {
        id: 'reinforced_stock', name: 'Reinforced Stock', emoji: '🛡️',
        costMultiplier: 0.25,
        effect: { durabilityReduction: 1 },
        description: 'Reduces durability loss by 1 per hunt (minimum 1)'
    }
};

// ─── AMMO PACKS ───────────────────────────────────────────────────────────────

const AMMO_PACKS = [
    {
        id: 'iron_shot_pack', name: 'Iron Shot (20)', emoji: '🔶',
        cost: 90, ammoType: 'iron_shot', quantity: 20,
        description: 'Ammunition for Iron Rifle'
    },
    {
        id: 'steel_shot_pack', name: 'Steel Shot (20)', emoji: '⚫',
        cost: 180, ammoType: 'steel_shot', quantity: 20,
        description: 'Ammunition for Steel Rifle'
    },
    {
        id: 'composite_round_pack', name: 'Composite Rounds (20)', emoji: '🔵',
        cost: 270, ammoType: 'composite_round', quantity: 20,
        description: 'Ammunition for Composite Rifle'
    },
    {
        id: 'titanium_round_pack', name: 'Titanium Rounds (20)', emoji: '💎',
        cost: 360, ammoType: 'titanium_round', quantity: 20,
        description: 'Ammunition for Titanium Rifle'
    }
];

// ─── CONSUMABLES ─────────────────────────────────────────────────────────────

const CONSUMABLES = {
    basic_bait: {
        id: 'basic_bait', name: 'Basic Bait', emoji: '🪱',
        cost: 80, type: 'bait', huntsLeft: 3,
        effect: { tierShift: 0.08 },
        description: '+8% rare tier chance for 3 hunts',
        maxStack: 10
    },
    premium_bait: {
        id: 'premium_bait', name: 'Premium Bait', emoji: '🎣',
        cost: 250, type: 'bait', huntsLeft: 3,
        effect: { tierShift: 0.15, epicShift: 0.05 },
        description: '+15% rare, +5% epic chance for 3 hunts',
        maxStack: 5
    },
    luck_charm: {
        id: 'luck_charm', name: 'Luck Charm', emoji: '🍀',
        cost: 150, type: 'charm', huntsLeft: 5,
        effect: { critBonus: 0.05, successBonus: 0.03 },
        description: '+5% crit, +3% success for 5 hunts',
        maxStack: 5
    },
    hunters_focus: {
        id: 'hunters_focus', name: "Hunter's Focus", emoji: '🎯',
        cost: 60, type: 'instant', huntsLeft: 1,
        effect: { successBonus: 0.10 },
        description: '+10% success chance for 1 hunt',
        maxStack: 10
    },
    repair_kit_small: {
        id: 'repair_kit_small', name: 'Repair Kit (Small)', emoji: '🔧',
        cost: 120, type: 'repair', durabilityRestore: 20,
        description: 'Restores 20 durability to equipped weapon',
        maxStack: 5
    },
    repair_kit_large: {
        id: 'repair_kit_large', name: 'Repair Kit (Large)', emoji: '🔨',
        cost: 280, type: 'repair', durabilityRestore: 50,
        description: 'Restores 50 durability to equipped weapon',
        maxStack: 3
    },
    stamina_tonic: {
        id: 'stamina_tonic', name: 'Stamina Tonic', emoji: '⚡',
        cost: 200, type: 'stamina', staminaRestore: 3,
        description: 'Restores 3 stamina (max 2 uses per day)',
        maxStack: 5
    },
    xp_scroll: {
        id: 'xp_scroll', name: 'XP Scroll', emoji: '📜',
        cost: 180, type: 'instant', huntsLeft: 1,
        effect: { xpMultiplier: 0.50 },
        description: '+50% XP on next hunt',
        maxStack: 10
    }
};

// ─── ZONES ───────────────────────────────────────────────────────────────────

const ZONES = {
    beginner_forest: {
        id: 'beginner_forest', name: 'Beginner Forest', emoji: '🌲',
        unlockLevel: 1, unlockCost: 0, defaultUnlocked: true,
        difficultyMod: 0.00, payoutBonus: 0.00,
        tierWeights: { common: 52, uncommon: 30, rare: 13, epic: 4, legendary: 1, event: 0 },
        description: 'A peaceful forest perfect for new hunters.'
    },
    desert_wastes: {
        id: 'desert_wastes', name: 'Desert Wastes', emoji: '🏜️',
        unlockLevel: 10, unlockCost: 3000, defaultUnlocked: false,
        difficultyMod: -0.05, payoutBonus: 0.00,
        tierWeights: { common: 42, uncommon: 30, rare: 18, epic: 7, legendary: 2.5, event: 0.5 },
        description: 'Harsh and unforgiving terrain with exotic wildlife.'
    },
    arctic_tundra: {
        id: 'arctic_tundra', name: 'Arctic Tundra', emoji: '🏔️',
        unlockLevel: 20, unlockCost: 12000, defaultUnlocked: false,
        difficultyMod: -0.08, payoutBonus: 0.00,
        tierWeights: { common: 35, uncommon: 28, rare: 22, epic: 11, legendary: 3.5, event: 0.5 },
        description: 'Freezing wilderness where rare creatures roam.'
    },
    murky_swamp: {
        id: 'murky_swamp', name: 'Murky Swamp', emoji: '🌿',
        unlockLevel: 30, unlockCost: 30000, defaultUnlocked: false,
        difficultyMod: -0.10, payoutBonus: 0.00,
        tierWeights: { common: 32, uncommon: 27, rare: 22, epic: 13, legendary: 5, event: 1 },
        description: 'Mysterious marshlands hiding dangerous prey.'
    },
    legendary_peaks: {
        id: 'legendary_peaks', name: 'Legendary Peaks', emoji: '⛰️',
        unlockLevel: 50, unlockCost: 75000, defaultUnlocked: false,
        difficultyMod: -0.12, payoutBonus: 0.20,
        tierWeights: { common: 15, uncommon: 22, rare: 28, epic: 22, legendary: 12, event: 1 },
        description: 'The ultimate hunting ground. Master hunters only.'
    }
};

const ZONE_LIST = Object.values(ZONES);

// ─── ANIMALS ─────────────────────────────────────────────────────────────────
// zones: ['all'] means available in every zone; otherwise specific zone ids.

const ANIMALS = {
    // ── COMMON ──────────────────────────────────────────────────────────────
    rabbit: {
        id: 'rabbit', name: 'Rabbit', emoji: '🐇', tier: 'common',
        payoutMin: 12, payoutMax: 28, xp: 10,
        specialDrop: { itemId: 'rabbits_foot', name: "Rabbit's Foot", chance: 0.04 },
        zones: ['all'],
        flavor: 'A swift cottontail darts through the brush.'
    },
    squirrel: {
        id: 'squirrel', name: 'Squirrel', emoji: '🐿️', tier: 'common',
        payoutMin: 8, payoutMax: 20, xp: 10,
        specialDrop: { itemId: 'acorn_cache', name: 'Acorn Cache', chance: 0.03 },
        zones: ['beginner_forest', 'murky_swamp'],
        flavor: 'A chattering squirrel scurries up the nearest tree.'
    },
    dove: {
        id: 'dove', name: 'Dove', emoji: '🕊️', tier: 'common',
        payoutMin: 14, payoutMax: 25, xp: 10,
        specialDrop: { itemId: 'feather', name: 'Feather', chance: 0.05 },
        zones: ['beginner_forest', 'desert_wastes'],
        flavor: 'A white dove takes flight in the open sky.'
    },
    quail: {
        id: 'quail', name: 'Quail', emoji: '🐦', tier: 'common',
        payoutMin: 16, payoutMax: 32, xp: 10,
        specialDrop: null,
        zones: ['beginner_forest', 'desert_wastes'],
        flavor: 'A small quail bursts from the tall grass.'
    },
    duck: {
        id: 'duck', name: 'Duck', emoji: '🦆', tier: 'common',
        payoutMin: 22, payoutMax: 42, xp: 10,
        specialDrop: { itemId: 'down_feather', name: 'Down Feather', chance: 0.06 },
        zones: ['murky_swamp', 'beginner_forest'],
        flavor: 'A mallard lifts off from the still water.'
    },
    pheasant: {
        id: 'pheasant', name: 'Pheasant', emoji: '🦚', tier: 'common',
        payoutMin: 26, payoutMax: 50, xp: 10,
        specialDrop: null,
        zones: ['beginner_forest'],
        flavor: 'A pheasant erupts from the underbrush in a flash of color.'
    },
    raccoon: {
        id: 'raccoon', name: 'Raccoon', emoji: '🦝', tier: 'common',
        payoutMin: 18, payoutMax: 38, xp: 10,
        specialDrop: { itemId: 'bandit_mask', name: 'Bandit Mask', chance: 0.01 },
        zones: ['beginner_forest', 'murky_swamp'],
        flavor: 'A masked bandit rummages through the campsite.'
    },

    // ── UNCOMMON ────────────────────────────────────────────────────────────
    deer: {
        id: 'deer', name: 'Deer', emoji: '🦌', tier: 'uncommon',
        payoutMin: 55, payoutMax: 110, xp: 25,
        specialDrop: { itemId: 'antler_fragment', name: 'Antler Fragment', chance: 0.08 },
        zones: ['beginner_forest', 'arctic_tundra'],
        flavor: 'A white-tailed deer grazes peacefully in the clearing.'
    },
    wild_boar: {
        id: 'wild_boar', name: 'Wild Boar', emoji: '🐗', tier: 'uncommon',
        payoutMin: 65, payoutMax: 125, xp: 25,
        specialDrop: { itemId: 'tusk_shard', name: 'Tusk Shard', chance: 0.07 },
        zones: ['beginner_forest', 'murky_swamp'],
        flavor: 'A tusked boar charges through the forest floor.'
    },
    turkey: {
        id: 'turkey', name: 'Turkey', emoji: '🦃', tier: 'uncommon',
        payoutMin: 60, payoutMax: 115, xp: 25,
        specialDrop: null,
        zones: ['beginner_forest'],
        flavor: 'A gobbling tom turkey struts in the meadow.'
    },
    badger: {
        id: 'badger', name: 'Badger', emoji: '🦡', tier: 'uncommon',
        payoutMin: 48, payoutMax: 95, xp: 25,
        specialDrop: { itemId: 'badger_pelt', name: 'Badger Pelt', chance: 0.09 },
        zones: ['beginner_forest', 'murky_swamp'],
        flavor: 'A feisty badger emerges from its burrow.'
    },
    beaver: {
        id: 'beaver', name: 'Beaver', emoji: '🦫', tier: 'uncommon',
        payoutMin: 52, payoutMax: 100, xp: 25,
        specialDrop: { itemId: 'beaver_pelt', name: 'Beaver Pelt', chance: 0.08 },
        zones: ['murky_swamp'],
        flavor: 'A beaver slaps its broad tail on the dark water.'
    },
    coyote: {
        id: 'coyote', name: 'Coyote', emoji: '🐕', tier: 'uncommon',
        payoutMin: 65, payoutMax: 120, xp: 25,
        specialDrop: { itemId: 'coyote_fang', name: 'Coyote Fang', chance: 0.05 },
        zones: ['desert_wastes', 'beginner_forest'],
        flavor: 'A lone coyote howls from a sun-bleached ridge.'
    },

    // ── RARE ────────────────────────────────────────────────────────────────
    wolf: {
        id: 'wolf', name: 'Wolf', emoji: '🐺', tier: 'rare',
        payoutMin: 130, payoutMax: 220, xp: 75,
        specialDrop: { itemId: 'wolf_pelt', name: 'Wolf Pelt', chance: 0.10 },
        zones: ['beginner_forest', 'arctic_tundra'],
        flavor: 'A grey wolf stalks you silently through the treeline.'
    },
    elk: {
        id: 'elk', name: 'Elk', emoji: '🫎', tier: 'rare',
        payoutMin: 160, payoutMax: 270, xp: 75,
        specialDrop: { itemId: 'elk_antler', name: 'Grand Antler', chance: 0.08 },
        zones: ['beginner_forest', 'arctic_tundra'],
        flavor: 'A massive bull elk bugles across the valley.'
    },
    lynx: {
        id: 'lynx', name: 'Lynx', emoji: '🐈', tier: 'rare',
        payoutMin: 145, payoutMax: 235, xp: 75,
        specialDrop: { itemId: 'lynx_fang', name: 'Lynx Fang', chance: 0.09 },
        zones: ['arctic_tundra'],
        flavor: 'A spotted lynx watches you with cold yellow eyes.'
    },
    bald_eagle: {
        id: 'bald_eagle', name: 'Bald Eagle', emoji: '🦅', tier: 'rare',
        payoutMin: 170, payoutMax: 290, xp: 75,
        specialDrop: { itemId: 'eagle_talon', name: 'Eagle Talon', chance: 0.06 },
        zones: ['all'],
        flavor: 'A bald eagle circles overhead, eyeing you keenly.'
    },
    mountain_goat: {
        id: 'mountain_goat', name: 'Mountain Goat', emoji: '🐐', tier: 'rare',
        payoutMin: 135, payoutMax: 215, xp: 75,
        specialDrop: { itemId: 'mountain_horn', name: 'Mountain Horn', chance: 0.07 },
        zones: ['arctic_tundra', 'legendary_peaks'],
        flavor: 'A sure-footed mountain goat leaps between rocky ledges.'
    },

    // ── EPIC ────────────────────────────────────────────────────────────────
    black_bear: {
        id: 'black_bear', name: 'Black Bear', emoji: '🐻', tier: 'epic',
        payoutMin: 300, payoutMax: 480, xp: 150,
        specialDrop: { itemId: 'bear_claw', name: 'Bear Claw', chance: 0.15 },
        zones: ['beginner_forest', 'arctic_tundra'],
        flavor: 'A black bear rears up on its hind legs, sniffing the air.'
    },
    moose: {
        id: 'moose', name: 'Moose', emoji: '🫎', tier: 'epic',
        payoutMin: 320, payoutMax: 520, xp: 150,
        specialDrop: { itemId: 'moose_rack', name: 'Moose Rack', chance: 0.12 },
        zones: ['beginner_forest', 'arctic_tundra'],
        flavor: 'A towering moose crashes through the undergrowth.'
    },
    mountain_lion: {
        id: 'mountain_lion', name: 'Mountain Lion', emoji: '🦁', tier: 'epic',
        payoutMin: 340, payoutMax: 540, xp: 150,
        specialDrop: { itemId: 'lion_tooth', name: "Lion's Tooth", chance: 0.12 },
        zones: ['legendary_peaks', 'desert_wastes'],
        flavor: 'A mountain lion stalks you from the rocky outcrop above.'
    },
    wolverine: {
        id: 'wolverine', name: 'Wolverine', emoji: '🦡', tier: 'epic',
        payoutMin: 280, payoutMax: 450, xp: 150,
        specialDrop: { itemId: 'wolverine_fur', name: 'Wolverine Fur', chance: 0.10 },
        zones: ['arctic_tundra', 'murky_swamp'],
        flavor: 'A ferocious wolverine snarls and charges straight at you!'
    },

    // ── LEGENDARY ────────────────────────────────────────────────────────────
    snow_leopard: {
        id: 'snow_leopard', name: 'Snow Leopard', emoji: '🐆', tier: 'legendary',
        payoutMin: 650, payoutMax: 1100, xp: 500,
        specialDrop: { itemId: 'spirit_pelt', name: 'Spirit Pelt', chance: 0.20 },
        zones: ['arctic_tundra', 'legendary_peaks'],
        flavor: 'A ghostly snow leopard materialises from the blizzard.'
    },
    giant_elk: {
        id: 'giant_elk', name: 'Giant Elk', emoji: '🦌', tier: 'legendary',
        payoutMin: 850, payoutMax: 1300, xp: 500,
        specialDrop: { itemId: 'megaloceros_crown', name: 'Megaloceros Crown', chance: 0.18 },
        zones: ['legendary_peaks'],
        flavor: 'An ancient Giant Elk stands like a living monument in the mist.'
    },
    golden_fox: {
        id: 'golden_fox', name: 'Golden Fox', emoji: '🦊', tier: 'legendary',
        payoutMin: 750, payoutMax: 1150, xp: 500,
        specialDrop: { itemId: 'golden_fur', name: 'Golden Fur', chance: 1.00 },
        zones: ['legendary_peaks', 'beginner_forest'],
        flavor: 'A shimmering golden fox vanishes between the trees in a flash of light.'
    },
    white_wolf: {
        id: 'white_wolf', name: 'White Wolf', emoji: '🐺', tier: 'legendary',
        payoutMin: 800, payoutMax: 1200, xp: 500,
        specialDrop: { itemId: 'spirit_essence', name: 'Spirit Essence', chance: 0.25 },
        zones: ['legendary_peaks', 'arctic_tundra'],
        flavor: 'A spectral white wolf howls beneath the aurora borealis.'
    },

    // ── EVENT / MYTHICAL ─────────────────────────────────────────────────────
    dire_bear: {
        id: 'dire_bear', name: 'Dire Bear', emoji: '🐻', tier: 'event',
        payoutMin: 1600, payoutMax: 2800, xp: 1000,
        specialDrop: { itemId: 'ancient_claw', name: 'Ancient Claw', chance: 0.30 },
        zones: ['murky_swamp'],
        flavor: 'An enormous prehistoric bear erupts from the swamp fog with a thunderous roar!'
    },
    thunderbird: {
        id: 'thunderbird', name: 'Thunderbird', emoji: '⚡', tier: 'event',
        payoutMin: 2200, payoutMax: 3600, xp: 1000,
        specialDrop: { itemId: 'thunderfeather', name: 'Thunderfeather', chance: 0.35 },
        zones: ['all'],
        flavor: 'Lightning splits the sky as a titanic Thunderbird descends from the clouds!'
    },
    ghost_stag: {
        id: 'ghost_stag', name: 'Ghost Stag', emoji: '👻', tier: 'event',
        payoutMin: 1900, payoutMax: 3100, xp: 1000,
        specialDrop: { itemId: 'spectral_bone', name: 'Spectral Bone', chance: 0.40 },
        zones: ['all'],
        flavor: 'A translucent stag shimmers in the silver moonlight, barely real.'
    }
};

// Animals indexed by tier for fast tier-roll lookup
const ANIMALS_BY_TIER = {};
for (const animal of Object.values(ANIMALS)) {
    if (!ANIMALS_BY_TIER[animal.tier]) ANIMALS_BY_TIER[animal.tier] = [];
    ANIMALS_BY_TIER[animal.tier].push(animal);
}

// ─── HUNTER LEVELS ───────────────────────────────────────────────────────────

const HUNTER_LEVELS = [
    { level: 1,  xpRequired: 0,      title: 'Rookie Hunter',   unlocks: [] },
    { level: 2,  xpRequired: 100,    title: 'Rookie Hunter',   unlocks: [] },
    { level: 3,  xpRequired: 200,    title: 'Rookie Hunter',   unlocks: [] },
    { level: 4,  xpRequired: 300,    title: 'Rookie Hunter',   unlocks: [] },
    { level: 5,  xpRequired: 500,    title: 'Amateur Hunter',  unlocks: [] },
    { level: 6,  xpRequired: 700,    title: 'Amateur Hunter',  unlocks: [] },
    { level: 7,  xpRequired: 900,    title: 'Amateur Hunter',  unlocks: [] },
    { level: 8,  xpRequired: 1100,   title: 'Amateur Hunter',  unlocks: [] },
    { level: 9,  xpRequired: 1300,   title: 'Amateur Hunter',  unlocks: [] },
    { level: 10, xpRequired: 1500,   title: 'Hunter',          unlocks: ['desert_wastes'] },
    { level: 11, xpRequired: 1900,   title: 'Hunter',          unlocks: [] },
    { level: 12, xpRequired: 2300,   title: 'Hunter',          unlocks: [] },
    { level: 13, xpRequired: 2700,   title: 'Hunter',          unlocks: [] },
    { level: 14, xpRequired: 3100,   title: 'Hunter',          unlocks: [] },
    { level: 15, xpRequired: 3500,   title: 'Tracker',         unlocks: [] },
    { level: 16, xpRequired: 4200,   title: 'Tracker',         unlocks: [] },
    { level: 17, xpRequired: 4900,   title: 'Tracker',         unlocks: [] },
    { level: 18, xpRequired: 5600,   title: 'Tracker',         unlocks: [] },
    { level: 19, xpRequired: 6300,   title: 'Tracker',         unlocks: [] },
    { level: 20, xpRequired: 7000,   title: 'Marksman',        unlocks: ['arctic_tundra'] },
    { level: 21, xpRequired: 8200,   title: 'Marksman',        unlocks: [] },
    { level: 22, xpRequired: 9400,   title: 'Marksman',        unlocks: [] },
    { level: 23, xpRequired: 10600,  title: 'Marksman',        unlocks: [] },
    { level: 24, xpRequired: 11800,  title: 'Marksman',        unlocks: [] },
    { level: 25, xpRequired: 13000,  title: 'Sharpshooter',    unlocks: [] },
    { level: 26, xpRequired: 14800,  title: 'Sharpshooter',    unlocks: [] },
    { level: 27, xpRequired: 16600,  title: 'Sharpshooter',    unlocks: [] },
    { level: 28, xpRequired: 18400,  title: 'Sharpshooter',    unlocks: [] },
    { level: 29, xpRequired: 20200,  title: 'Sharpshooter',    unlocks: [] },
    { level: 30, xpRequired: 22000,  title: 'Expert Hunter',   unlocks: ['murky_swamp'] },
    { level: 31, xpRequired: 24300,  title: 'Expert Hunter',   unlocks: [] },
    { level: 32, xpRequired: 26600,  title: 'Expert Hunter',   unlocks: [] },
    { level: 33, xpRequired: 28900,  title: 'Expert Hunter',   unlocks: [] },
    { level: 34, xpRequired: 31200,  title: 'Expert Hunter',   unlocks: [] },
    { level: 35, xpRequired: 33500,  title: 'Expert Hunter',   unlocks: [] },
    { level: 36, xpRequired: 35800,  title: 'Expert Hunter',   unlocks: [] },
    { level: 37, xpRequired: 38100,  title: 'Expert Hunter',   unlocks: [] },
    { level: 38, xpRequired: 40400,  title: 'Expert Hunter',   unlocks: [] },
    { level: 39, xpRequired: 42700,  title: 'Expert Hunter',   unlocks: [] },
    { level: 40, xpRequired: 45000,  title: 'Elite Hunter',    unlocks: [] },
    { level: 41, xpRequired: 49500,  title: 'Elite Hunter',    unlocks: [] },
    { level: 42, xpRequired: 54000,  title: 'Elite Hunter',    unlocks: [] },
    { level: 43, xpRequired: 58500,  title: 'Elite Hunter',    unlocks: [] },
    { level: 44, xpRequired: 63000,  title: 'Elite Hunter',    unlocks: [] },
    { level: 45, xpRequired: 67500,  title: 'Elite Hunter',    unlocks: [] },
    { level: 46, xpRequired: 72000,  title: 'Elite Hunter',    unlocks: [] },
    { level: 47, xpRequired: 76500,  title: 'Elite Hunter',    unlocks: [] },
    { level: 48, xpRequired: 81000,  title: 'Elite Hunter',    unlocks: [] },
    { level: 49, xpRequired: 85500,  title: 'Elite Hunter',    unlocks: [] },
    { level: 50, xpRequired: 90000,  title: 'Master Hunter',   unlocks: ['legendary_peaks'] }
];

// ─── TIER EMBED COLORS ────────────────────────────────────────────────────────

const TIER_COLORS = {
    common:    '#95a5a6',
    uncommon:  '#2ecc71',
    rare:      '#3498db',
    epic:      '#9b59b6',
    legendary: '#f39c12',
    event:     '#e74c3c'
};

// ─── ANTI-EXPLOIT CONSTANTS ───────────────────────────────────────────────────

const LIMITS = {
    HUNT_COOLDOWN_MS:        30_000,        // 30 seconds between hunts
    INJURY_PENALTY_MS:       15 * 60_000,   // +15 min on injury
    STAMINA_REGEN_MS:        6 * 60_000,    // 1 stamina per 6 minutes
    MAX_STAMINA_BASE:        10,
    DAILY_WINDOW_MS:         24 * 3600_000, // rolling 24h window
    DAILY_SOFT_CAP:          80_000,        // 50% payout reduction above this
    DAILY_HARD_CAP:          150_000,       // 0 coins above this
    DIM_RETURNS_THRESHOLD_1: 60,            // after 60 hunts/day → ×0.85
    DIM_RETURNS_THRESHOLD_2: 90,            // after 90 → ×0.70
    DIM_RETURNS_THRESHOLD_3: 120,           // after 120 → ×0.55
    MAX_CRIT_CHANCE:         0.25,          // 25% hard cap on crit
    STAMINA_TONICS_PER_DAY:  2,
    PITY_CONSECUTIVE_FAILS:  4,             // after N fails, +15% success (stacks 4×)
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

module.exports = {
    WEAPON_TIERS,
    WEAPON_BY_SLUG,
    WEAPON_BY_TIER,
    WEAPON_UPGRADES,
    AMMO_PACKS,
    CONSUMABLES,
    ZONES,
    ZONE_LIST,
    ANIMALS,
    ANIMALS_BY_TIER,
    HUNTER_LEVELS,
    TIER_COLORS,
    LIMITS,
    PRESTIGE_BONUSES
};
