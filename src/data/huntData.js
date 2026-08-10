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
        cost: 2500, baseDurability: 110, successRate: 0.53, rarityBoost: 0.02,
        requiresAmmo: true, ammoType: 'iron_shot', ammoCost: 5,
        repairCostPer20: 180,
        description: 'A solid iron rifle with better accuracy and range.'
    },
    {
        tier: 3, slug: 'copper_rifle', name: 'Copper Rifle', emoji: '🟤',
        cost: 5500, baseDurability: 140, successRate: 0.59, rarityBoost: 0.04,
        requiresAmmo: true, ammoType: 'iron_shot', ammoCost: 5,
        repairCostPer20: 320,
        description: 'A copper-forged rifle with improved precision.'
    },
    {
        tier: 4, slug: 'steel_rifle', name: 'Steel Rifle', emoji: '🔫',
        cost: 12000, baseDurability: 170, successRate: 0.65, rarityBoost: 0.06,
        requiresAmmo: true, ammoType: 'steel_shot', ammoCost: 10,
        repairCostPer20: 550,
        description: 'A precision steel rifle for serious hunters.'
    },
    {
        tier: 5, slug: 'cobalt_rifle', name: 'Cobalt Rifle', emoji: '🔵',
        cost: 30000, baseDurability: 200, successRate: 0.70, rarityBoost: 0.09,
        requiresAmmo: true, ammoType: 'steel_shot', ammoCost: 10,
        repairCostPer20: 1100,
        description: 'A cobalt-alloy rifle favored by veteran hunters.'
    },
    {
        tier: 6, slug: 'gold_rifle', name: 'Gold Rifle', emoji: '🌟',
        cost: 80000, baseDurability: 230, successRate: 0.74, rarityBoost: 0.12,
        requiresAmmo: true, ammoType: 'composite_round', ammoCost: 15,
        repairCostPer20: 2500,
        description: 'A gilded rifle that commands respect in any hunting ground.'
    },
    {
        tier: 7, slug: 'platinum_rifle', name: 'Platinum Rifle', emoji: '✨',
        cost: 200000, baseDurability: 260, successRate: 0.78, rarityBoost: 0.16,
        requiresAmmo: true, ammoType: 'composite_round', ammoCost: 15,
        repairCostPer20: 5500,
        description: 'A sleek platinum rifle engineered for elite hunters.'
    },
    {
        tier: 8, slug: 'crimson_rifle', name: 'Crimson Rifle', emoji: '🔴',
        cost: 500000, baseDurability: 290, successRate: 0.81, rarityBoost: 0.20,
        requiresAmmo: true, ammoType: 'composite_round', ammoCost: 15,
        repairCostPer20: 12000,
        description: 'A blood-red enchanted rifle that draws out rare prey.'
    },
    {
        tier: 9, slug: 'adamantine_rifle', name: 'Adamantine Rifle', emoji: '💜',
        cost: 1200000, baseDurability: 325, successRate: 0.84, rarityBoost: 0.25,
        requiresAmmo: true, ammoType: 'titanium_round', ammoCost: 20,
        repairCostPer20: 28000,
        description: 'Forged from the hardest known metal. Near-indestructible.'
    },
    {
        tier: 10, slug: 'fateful_rifle', name: 'Fateful Rifle', emoji: '🌑',
        cost: 3000000, baseDurability: 360, successRate: 0.87, rarityBoost: 0.30,
        requiresAmmo: true, ammoType: 'titanium_round', ammoCost: 20,
        repairCostPer20: 60000,
        description: 'A rifle imbued with the power of fate itself.'
    },
    {
        tier: 11, slug: 'angelic_rifle', name: 'Angelic Rifle', emoji: '💛',
        cost: 7500000, baseDurability: 400, successRate: 0.90, rarityBoost: 0.36,
        requiresAmmo: true, ammoType: 'titanium_round', ammoCost: 20,
        repairCostPer20: 130000,
        description: 'A divine weapon blessed by celestial forces.'
    },
    {
        tier: 12, slug: 'altair_rifle', name: 'Altair Rifle', emoji: '⭐',
        cost: 20000000, baseDurability: 450, successRate: 0.93, rarityBoost: 0.44,
        requiresAmmo: true, ammoType: 'titanium_round', ammoCost: 20,
        repairCostPer20: 280000,
        description: 'The star-forged pinnacle of hunting. Mythical in every sense.'
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
        description: 'Ammunition for Iron & Copper Rifles (T2–T3)'
    },
    {
        id: 'steel_shot_pack', name: 'Steel Shot (20)', emoji: '⚫',
        cost: 180, ammoType: 'steel_shot', quantity: 20,
        description: 'Ammunition for Steel & Cobalt Rifles (T4–T5)'
    },
    {
        id: 'composite_round_pack', name: 'Composite Rounds (20)', emoji: '🔵',
        cost: 270, ammoType: 'composite_round', quantity: 20,
        description: 'Ammunition for Gold, Platinum & Crimson Rifles (T6–T8)'
    },
    {
        id: 'titanium_round_pack', name: 'Titanium Rounds (20)', emoji: '💎',
        cost: 360, ammoType: 'titanium_round', quantity: 20,
        description: 'Ammunition for Adamantine through Altair Rifles (T9–T12)'
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
        description: 'A peaceful forest perfect for new hunters.',
        zoneMaterials: ['rabbits_foot', 'feather', 'down_feather', 'acorn_cache', 'wolf_pelt', 'badger_pelt', 'antler_fragment', 'elk_antler', 'bear_claw', 'moose_rack', 'striped_pelt', 'hardwood_chip', 'crow_feather', 'opossum_pelt']
    },
    desert_wastes: {
        id: 'desert_wastes', name: 'Desert Wastes', emoji: '🏜️',
        unlockLevel: 10, unlockCost: 3000, defaultUnlocked: false,
        difficultyMod: -0.05, payoutBonus: 0.00,
        tierWeights: { common: 42, uncommon: 30, rare: 18, epic: 7, legendary: 2.5, event: 0.5 },
        description: 'Harsh and unforgiving terrain with exotic wildlife.',
        zoneMaterials: ['venom_sac', 'scorpion_claw', 'coyote_fang', 'hyena_fang', 'sand_pelt', 'jackrabbit_foot', 'scavenger_feather', 'lion_tooth']
    },
    arctic_tundra: {
        id: 'arctic_tundra', name: 'Arctic Tundra', emoji: '🏔️',
        unlockLevel: 20, unlockCost: 12000, defaultUnlocked: false,
        difficultyMod: -0.08, payoutBonus: 0.00,
        tierWeights: { common: 35, uncommon: 28, rare: 22, epic: 11, legendary: 3.5, event: 0.5 },
        description: 'Freezing wilderness where rare creatures roam.',
        zoneMaterials: ['mammoth_tusk', 'arctic_fox_pelt', 'wolverine_fur', 'polar_claw', 'saber_fang', 'snowy_feather', 'caribou_antler', 'lynx_fang', 'thick_hide']
    },
    murky_swamp: {
        id: 'murky_swamp', name: 'Murky Swamp', emoji: '🌿',
        unlockLevel: 30, unlockCost: 30000, defaultUnlocked: false,
        difficultyMod: -0.10, payoutBonus: 0.00,
        tierWeights: { common: 32, uncommon: 27, rare: 22, epic: 13, legendary: 5, event: 1 },
        description: 'Mysterious marshlands hiding dangerous prey.',
        zoneMaterials: ['swamp_scale', 'swamp_gland', 'cottonmouth_venom', 'gator_hide', 'marsh_feather', 'hog_tusk', 'shadow_pelt', 'beaver_pelt', 'slick_skin']
    },
    legendary_peaks: {
        id: 'legendary_peaks', name: 'Legendary Peaks', emoji: '⛰️',
        unlockLevel: 50, unlockCost: 75000, defaultUnlocked: false,
        difficultyMod: -0.12, payoutBonus: 0.20,
        tierWeights: { common: 15, uncommon: 22, rare: 28, epic: 22, legendary: 12, event: 1 },
        description: 'The ultimate hunting ground. Master hunters only.',
        zoneMaterials: ['ancient_relic', 'spirit_essence', 'spirit_pelt', 'ram_horn', 'dire_wolf_fang', 'primal_claw', 'obsidian_antler', 'storm_feather', 'ember_fang', 'megaloceros_crown']
    }
};

const ZONE_LIST = Object.values(ZONES);

// ─── ANIMAL TRAITS ───────────────────────────────────────────────────────────

const ANIMAL_TRAITS = {
    aggressive: {
        id: 'aggressive', name: 'Aggressive', emoji: '⚔️',
        description: 'Can injure the hunter even on a successful hunt (30% chance, +15 min cooldown)'
    },
    elusive: {
        id: 'elusive', name: 'Elusive', emoji: '💨',
        description: 'Harder to hit — reduces effective success chance by 10%'
    },
    armored: {
        id: 'armored', name: 'Armored', emoji: '🛡️',
        description: 'Thick hide absorbs impacts — critical hits are negated'
    },
    pack_hunter: {
        id: 'pack_hunter', name: 'Pack Hunter', emoji: '🐾',
        description: 'Draws its pack — failures deal +3 extra durability damage'
    },
    giant: {
        id: 'giant', name: 'Giant', emoji: '💪',
        description: 'Enormous size causes extra weapon wear (+1 durability loss per hunt)'
    },
    venomous: {
        id: 'venomous', name: 'Venomous', emoji: '☠️',
        description: 'Bite or sting costs an extra stamina on hunt'
    },
    spectral: {
        id: 'spectral', name: 'Spectral', emoji: '👻',
        description: 'Otherworldly nature — luck charms lose half their effectiveness'
    },
    enraged: {
        id: 'enraged', name: 'Enraged', emoji: '🔥',
        description: 'Permanent fury grants +25% payout on a successful hunt'
    }
};

// ─── ANIMALS ─────────────────────────────────────────────────────────────────
// zones: ['all'] means available in every zone; otherwise specific zone ids.
// traits: array of trait IDs from ANIMAL_TRAITS (optional).

const ANIMALS = {
    // ── COMMON ──────────────────────────────────────────────────────────────
    rabbit: {
        id: 'rabbit', name: 'Rabbit', emoji: '🐇', tier: 'common',
        payoutMin: 12, payoutMax: 28, xp: 10,
        specialDrop: { itemId: 'rabbits_foot', name: "Rabbit's Foot", chance: 0.04 },
        zones: ['all'], traits: [],
        flavor: 'A swift cottontail darts through the brush.'
    },
    squirrel: {
        id: 'squirrel', name: 'Squirrel', emoji: '🐿️', tier: 'common',
        payoutMin: 8, payoutMax: 20, xp: 10,
        specialDrop: { itemId: 'acorn_cache', name: 'Acorn Cache', chance: 0.03 },
        zones: ['beginner_forest', 'murky_swamp'], traits: [],
        flavor: 'A chattering squirrel scurries up the nearest tree.'
    },
    dove: {
        id: 'dove', name: 'Dove', emoji: '🕊️', tier: 'common',
        payoutMin: 14, payoutMax: 25, xp: 10,
        specialDrop: { itemId: 'feather', name: 'Feather', chance: 0.05 },
        zones: ['beginner_forest', 'desert_wastes'], traits: [],
        flavor: 'A white dove takes flight in the open sky.'
    },
    quail: {
        id: 'quail', name: 'Quail', emoji: '🐦', tier: 'common',
        payoutMin: 16, payoutMax: 32, xp: 10,
        specialDrop: null,
        zones: ['beginner_forest', 'desert_wastes'], traits: [],
        flavor: 'A small quail bursts from the tall grass.'
    },
    duck: {
        id: 'duck', name: 'Duck', emoji: '🦆', tier: 'common',
        payoutMin: 22, payoutMax: 42, xp: 10,
        specialDrop: { itemId: 'down_feather', name: 'Down Feather', chance: 0.06 },
        zones: ['murky_swamp', 'beginner_forest'], traits: [],
        flavor: 'A mallard lifts off from the still water.'
    },
    pheasant: {
        id: 'pheasant', name: 'Pheasant', emoji: '🦚', tier: 'common',
        payoutMin: 26, payoutMax: 50, xp: 10,
        specialDrop: null,
        zones: ['beginner_forest'], traits: [],
        flavor: 'A pheasant erupts from the underbrush in a flash of color.'
    },
    raccoon: {
        id: 'raccoon', name: 'Raccoon', emoji: '🦝', tier: 'common',
        payoutMin: 18, payoutMax: 38, xp: 10,
        specialDrop: { itemId: 'bandit_mask', name: 'Bandit Mask', chance: 0.01 },
        zones: ['beginner_forest', 'murky_swamp'], traits: ['aggressive'],
        flavor: 'A masked bandit rummages through the campsite.'
    },
    chipmunk: {
        id: 'chipmunk', name: 'Chipmunk', emoji: '🐿️', tier: 'common',
        payoutMin: 8, payoutMax: 18, xp: 10,
        specialDrop: { itemId: 'striped_pelt', name: 'Striped Pelt', chance: 0.03 },
        zones: ['beginner_forest'], traits: [],
        flavor: 'A tiny chipmunk freezes mid-sprint, cheeks stuffed with acorns.'
    },
    crow: {
        id: 'crow', name: 'Crow', emoji: '🐦', tier: 'common',
        payoutMin: 12, payoutMax: 24, xp: 10,
        specialDrop: { itemId: 'crow_feather', name: 'Crow Feather', chance: 0.04 },
        zones: ['all'], traits: [],
        flavor: 'A glossy crow caws loudly from a dead branch.'
    },
    frog: {
        id: 'frog', name: 'Frog', emoji: '🐸', tier: 'common',
        payoutMin: 10, payoutMax: 20, xp: 10,
        specialDrop: { itemId: 'slick_skin', name: 'Slick Skin', chance: 0.04 },
        zones: ['murky_swamp', 'beginner_forest'], traits: [],
        flavor: 'A green frog leaps from a lily pad with a resonant splash.'
    },
    opossum: {
        id: 'opossum', name: 'Opossum', emoji: '🐀', tier: 'common',
        payoutMin: 14, payoutMax: 28, xp: 10,
        specialDrop: { itemId: 'opossum_pelt', name: 'Opossum Pelt', chance: 0.03 },
        zones: ['beginner_forest', 'murky_swamp'], traits: ['elusive'],
        flavor: "A hissing opossum plays dead until you're almost on top of it."
    },
    woodpecker: {
        id: 'woodpecker', name: 'Woodpecker', emoji: '🐦', tier: 'common',
        payoutMin: 15, payoutMax: 30, xp: 10,
        specialDrop: { itemId: 'hardwood_chip', name: 'Hardwood Chip', chance: 0.05 },
        zones: ['beginner_forest'], traits: [],
        flavor: 'A red-crested woodpecker hammers away at an old oak.'
    },

    // ── UNCOMMON ────────────────────────────────────────────────────────────
    deer: {
        id: 'deer', name: 'Deer', emoji: '🦌', tier: 'uncommon',
        payoutMin: 55, payoutMax: 110, xp: 25,
        specialDrop: { itemId: 'antler_fragment', name: 'Antler Fragment', chance: 0.08 },
        zones: ['beginner_forest', 'arctic_tundra'], traits: [],
        flavor: 'A white-tailed deer grazes peacefully in the clearing.'
    },
    wild_boar: {
        id: 'wild_boar', name: 'Wild Boar', emoji: '🐗', tier: 'uncommon',
        payoutMin: 65, payoutMax: 125, xp: 25,
        specialDrop: { itemId: 'tusk_shard', name: 'Tusk Shard', chance: 0.07 },
        zones: ['beginner_forest', 'murky_swamp'], traits: ['aggressive'],
        flavor: 'A tusked boar charges through the forest floor.'
    },
    turkey: {
        id: 'turkey', name: 'Turkey', emoji: '🦃', tier: 'uncommon',
        payoutMin: 60, payoutMax: 115, xp: 25,
        specialDrop: null,
        zones: ['beginner_forest'], traits: [],
        flavor: 'A gobbling tom turkey struts in the meadow.'
    },
    badger: {
        id: 'badger', name: 'Badger', emoji: '🦡', tier: 'uncommon',
        payoutMin: 48, payoutMax: 95, xp: 25,
        specialDrop: { itemId: 'badger_pelt', name: 'Badger Pelt', chance: 0.09 },
        zones: ['beginner_forest', 'murky_swamp'], traits: ['aggressive'],
        flavor: 'A feisty badger emerges from its burrow.'
    },
    beaver: {
        id: 'beaver', name: 'Beaver', emoji: '🦫', tier: 'uncommon',
        payoutMin: 52, payoutMax: 100, xp: 25,
        specialDrop: { itemId: 'beaver_pelt', name: 'Beaver Pelt', chance: 0.08 },
        zones: ['murky_swamp'], traits: [],
        flavor: 'A beaver slaps its broad tail on the dark water.'
    },
    coyote: {
        id: 'coyote', name: 'Coyote', emoji: '🐕', tier: 'uncommon',
        payoutMin: 65, payoutMax: 120, xp: 25,
        specialDrop: { itemId: 'coyote_fang', name: 'Coyote Fang', chance: 0.05 },
        zones: ['desert_wastes', 'beginner_forest'], traits: ['elusive'],
        flavor: 'A lone coyote howls from a sun-bleached ridge.'
    },
    jackrabbit: {
        id: 'jackrabbit', name: 'Jackrabbit', emoji: '🐇', tier: 'uncommon',
        payoutMin: 50, payoutMax: 100, xp: 25,
        specialDrop: { itemId: 'jackrabbit_foot', name: "Jackrabbit's Foot", chance: 0.06 },
        zones: ['desert_wastes'], traits: ['elusive'],
        flavor: 'A jackrabbit bolts across the sand flats in a zigzag blur.'
    },
    vulture: {
        id: 'vulture', name: 'Vulture', emoji: '🦅', tier: 'uncommon',
        payoutMin: 55, payoutMax: 105, xp: 25,
        specialDrop: { itemId: 'scavenger_feather', name: 'Scavenger Feather', chance: 0.07 },
        zones: ['desert_wastes'], traits: [],
        flavor: 'A bald-headed vulture circles lazily on the hot thermals.'
    },
    roadrunner: {
        id: 'roadrunner', name: 'Roadrunner', emoji: '🐦', tier: 'uncommon',
        payoutMin: 52, payoutMax: 98, xp: 25,
        specialDrop: null,
        zones: ['desert_wastes'], traits: ['elusive'],
        flavor: 'A roadrunner dashes across the cracked earth at blinding speed.'
    },
    scorpion: {
        id: 'scorpion', name: 'Scorpion', emoji: '🦂', tier: 'uncommon',
        payoutMin: 55, payoutMax: 108, xp: 25,
        specialDrop: { itemId: 'scorpion_claw', name: 'Scorpion Claw', chance: 0.08 },
        zones: ['desert_wastes'], traits: ['venomous'],
        flavor: 'A large scorpion emerges from beneath a sun-bleached rock, stinger raised.'
    },
    desert_fox: {
        id: 'desert_fox', name: 'Desert Fox', emoji: '🦊', tier: 'uncommon',
        payoutMin: 60, payoutMax: 118, xp: 25,
        specialDrop: { itemId: 'sand_pelt', name: 'Sand Pelt', chance: 0.08 },
        zones: ['desert_wastes'], traits: [],
        flavor: 'A fennec fox peers from behind a cactus with enormous ears perked up.'
    },
    crane: {
        id: 'crane', name: 'Crane', emoji: '🦢', tier: 'uncommon',
        payoutMin: 55, payoutMax: 105, xp: 25,
        specialDrop: { itemId: 'marsh_feather', name: 'Marsh Feather', chance: 0.06 },
        zones: ['murky_swamp'], traits: [],
        flavor: 'A great crane stands motionless in the shallows, watching the water.'
    },
    wild_hog: {
        id: 'wild_hog', name: 'Wild Hog', emoji: '🐗', tier: 'uncommon',
        payoutMin: 62, payoutMax: 115, xp: 25,
        specialDrop: { itemId: 'hog_tusk', name: 'Hog Tusk', chance: 0.07 },
        zones: ['murky_swamp'], traits: ['aggressive'],
        flavor: 'A mud-caked wild hog bursts from the reeds with a furious squeal.'
    },
    giant_salamander: {
        id: 'giant_salamander', name: 'Giant Salamander', emoji: '🦎', tier: 'uncommon',
        payoutMin: 58, payoutMax: 112, xp: 25,
        specialDrop: { itemId: 'swamp_scale', name: 'Swamp Scale', chance: 0.07 },
        zones: ['murky_swamp'], traits: [],
        flavor: 'An enormous spotted salamander slides out of the black shallows, scales gleaming.'
    },

    // ── RARE ────────────────────────────────────────────────────────────────
    wolf: {
        id: 'wolf', name: 'Wolf', emoji: '🐺', tier: 'rare',
        payoutMin: 130, payoutMax: 220, xp: 75,
        specialDrop: { itemId: 'wolf_pelt', name: 'Wolf Pelt', chance: 0.10 },
        zones: ['beginner_forest', 'arctic_tundra'], traits: ['pack_hunter'],
        flavor: 'A grey wolf stalks you silently through the treeline.'
    },
    elk: {
        id: 'elk', name: 'Elk', emoji: '🫎', tier: 'rare',
        payoutMin: 160, payoutMax: 270, xp: 75,
        specialDrop: { itemId: 'elk_antler', name: 'Grand Antler', chance: 0.08 },
        zones: ['beginner_forest', 'arctic_tundra'], traits: ['giant'],
        flavor: 'A massive bull elk bugles across the valley.'
    },
    lynx: {
        id: 'lynx', name: 'Lynx', emoji: '🐈', tier: 'rare',
        payoutMin: 145, payoutMax: 235, xp: 75,
        specialDrop: { itemId: 'lynx_fang', name: 'Lynx Fang', chance: 0.09 },
        zones: ['arctic_tundra'], traits: ['elusive'],
        flavor: 'A spotted lynx watches you with cold yellow eyes.'
    },
    bald_eagle: {
        id: 'bald_eagle', name: 'Bald Eagle', emoji: '🦅', tier: 'rare',
        payoutMin: 170, payoutMax: 290, xp: 75,
        specialDrop: { itemId: 'eagle_talon', name: 'Eagle Talon', chance: 0.06 },
        zones: ['all'], traits: ['elusive'],
        flavor: 'A bald eagle circles overhead, eyeing you keenly.'
    },
    mountain_goat: {
        id: 'mountain_goat', name: 'Mountain Goat', emoji: '🐐', tier: 'rare',
        payoutMin: 135, payoutMax: 215, xp: 75,
        specialDrop: { itemId: 'mountain_horn', name: 'Mountain Horn', chance: 0.07 },
        zones: ['arctic_tundra', 'legendary_peaks'], traits: ['elusive', 'armored'],
        flavor: 'A sure-footed mountain goat leaps between rocky ledges.'
    },
    rattlesnake: {
        id: 'rattlesnake', name: 'Rattlesnake', emoji: '🐍', tier: 'rare',
        payoutMin: 140, payoutMax: 240, xp: 75,
        specialDrop: { itemId: 'venom_sac', name: 'Venom Sac', chance: 0.10 },
        zones: ['desert_wastes'], traits: ['venomous'],
        flavor: 'A diamondback rattlesnake coils in the sun, shaking its lethal rattle.'
    },
    hyena: {
        id: 'hyena', name: 'Hyena', emoji: '🐕', tier: 'rare',
        payoutMin: 150, payoutMax: 250, xp: 75,
        specialDrop: { itemId: 'hyena_fang', name: 'Hyena Fang', chance: 0.09 },
        zones: ['desert_wastes'], traits: ['pack_hunter'],
        flavor: 'A spotted hyena cackles in the darkness at the edge of camp.'
    },
    caribou: {
        id: 'caribou', name: 'Caribou', emoji: '🦌', tier: 'rare',
        payoutMin: 155, payoutMax: 260, xp: 75,
        specialDrop: { itemId: 'caribou_antler', name: 'Caribou Antler', chance: 0.08 },
        zones: ['arctic_tundra'], traits: ['giant'],
        flavor: 'A caribou trudges across the frozen tundra, antlers caked in frost.'
    },
    arctic_fox: {
        id: 'arctic_fox', name: 'Arctic Fox', emoji: '🦊', tier: 'rare',
        payoutMin: 140, payoutMax: 230, xp: 75,
        specialDrop: { itemId: 'arctic_fox_pelt', name: 'Arctic Fox Pelt', chance: 0.10 },
        zones: ['arctic_tundra'], traits: ['elusive'],
        flavor: 'A pristine white arctic fox vanishes into the snowdrift in an instant.'
    },
    snowy_owl: {
        id: 'snowy_owl', name: 'Snowy Owl', emoji: '🦉', tier: 'rare',
        payoutMin: 160, payoutMax: 265, xp: 75,
        specialDrop: { itemId: 'snowy_feather', name: 'Snowy Feather', chance: 0.08 },
        zones: ['arctic_tundra'], traits: [],
        flavor: 'A great snowy owl swoops silently from the frozen treetops.'
    },
    giant_frog: {
        id: 'giant_frog', name: 'Giant Frog', emoji: '🐸', tier: 'rare',
        payoutMin: 135, payoutMax: 225, xp: 75,
        specialDrop: { itemId: 'swamp_gland', name: 'Swamp Gland', chance: 0.11 },
        zones: ['murky_swamp'], traits: ['venomous', 'giant'],
        flavor: 'An enormous frog erupts from the mud, its toxic skin glistening.'
    },
    cottonmouth: {
        id: 'cottonmouth', name: 'Cottonmouth', emoji: '🐍', tier: 'rare',
        payoutMin: 145, payoutMax: 240, xp: 75,
        specialDrop: { itemId: 'cottonmouth_venom', name: 'Cottonmouth Venom', chance: 0.10 },
        zones: ['murky_swamp'], traits: ['venomous'],
        flavor: 'A cottonmouth flashes its white mouth as a warning from the dark water.'
    },
    ancient_ram: {
        id: 'ancient_ram', name: 'Ancient Ram', emoji: '🐏', tier: 'rare',
        payoutMin: 165, payoutMax: 275, xp: 75,
        specialDrop: { itemId: 'ram_horn', name: 'Ram Horn', chance: 0.09 },
        zones: ['legendary_peaks'], traits: ['armored'],
        flavor: 'A battle-scarred ram stands unmoving at the edge of a sheer cliff.'
    },
    ruin_stalker: {
        id: 'ruin_stalker', name: 'Ruin Stalker', emoji: '🗿', tier: 'rare',
        payoutMin: 155, payoutMax: 265, xp: 75,
        specialDrop: { itemId: 'ancient_relic', name: 'Ancient Relic', chance: 0.10 },
        zones: ['legendary_peaks'], traits: ['armored', 'spectral'],
        flavor: 'A creature of living stone guards a forgotten altar at the summit.'
    },

    // ── EPIC ────────────────────────────────────────────────────────────────
    black_bear: {
        id: 'black_bear', name: 'Black Bear', emoji: '🐻', tier: 'epic',
        payoutMin: 300, payoutMax: 480, xp: 150,
        specialDrop: { itemId: 'bear_claw', name: 'Bear Claw', chance: 0.15 },
        zones: ['beginner_forest', 'arctic_tundra'], traits: ['aggressive', 'giant'],
        flavor: 'A black bear rears up on its hind legs, sniffing the air.'
    },
    moose: {
        id: 'moose', name: 'Moose', emoji: '🫎', tier: 'epic',
        payoutMin: 320, payoutMax: 520, xp: 150,
        specialDrop: { itemId: 'moose_rack', name: 'Moose Rack', chance: 0.12 },
        zones: ['beginner_forest', 'arctic_tundra'], traits: ['giant'],
        flavor: 'A towering moose crashes through the undergrowth.'
    },
    mountain_lion: {
        id: 'mountain_lion', name: 'Mountain Lion', emoji: '🦁', tier: 'epic',
        payoutMin: 340, payoutMax: 540, xp: 150,
        specialDrop: { itemId: 'lion_tooth', name: "Lion's Tooth", chance: 0.12 },
        zones: ['legendary_peaks', 'desert_wastes'], traits: ['aggressive', 'elusive'],
        flavor: 'A mountain lion stalks you from the rocky outcrop above.'
    },
    wolverine: {
        id: 'wolverine', name: 'Wolverine', emoji: '🦡', tier: 'epic',
        payoutMin: 280, payoutMax: 450, xp: 150,
        specialDrop: { itemId: 'wolverine_fur', name: 'Wolverine Fur', chance: 0.10 },
        zones: ['arctic_tundra', 'murky_swamp'], traits: ['aggressive'],
        flavor: 'A ferocious wolverine snarls and charges straight at you!'
    },
    musk_ox: {
        id: 'musk_ox', name: 'Musk Ox', emoji: '🐃', tier: 'epic',
        payoutMin: 290, payoutMax: 470, xp: 150,
        specialDrop: { itemId: 'thick_hide', name: 'Thick Hide', chance: 0.12 },
        zones: ['arctic_tundra'], traits: ['armored', 'giant'],
        flavor: 'A massive musk ox lowers its horns and paws the frozen ground.'
    },
    woolly_mammoth: {
        id: 'woolly_mammoth', name: 'Woolly Mammoth', emoji: '🦣', tier: 'epic',
        payoutMin: 310, payoutMax: 500, xp: 150,
        specialDrop: { itemId: 'mammoth_tusk', name: 'Mammoth Tusk', chance: 0.14 },
        zones: ['arctic_tundra'], traits: ['giant', 'armored'],
        flavor: 'An ancient woolly mammoth emerges from the blizzard, curved tusks sheathed in ice.'
    },
    polar_bear: {
        id: 'polar_bear', name: 'Polar Bear', emoji: '🐻‍❄️', tier: 'epic',
        payoutMin: 330, payoutMax: 530, xp: 150,
        specialDrop: { itemId: 'polar_claw', name: 'Polar Claw', chance: 0.13 },
        zones: ['arctic_tundra'], traits: ['aggressive', 'giant'],
        flavor: 'A massive polar bear rises from the ice floe, blotting out the horizon.'
    },
    saber_cat: {
        id: 'saber_cat', name: 'Saber Cat', emoji: '🐯', tier: 'epic',
        payoutMin: 310, payoutMax: 505, xp: 150,
        specialDrop: { itemId: 'saber_fang', name: 'Saber Fang', chance: 0.14 },
        zones: ['arctic_tundra', 'legendary_peaks'], traits: ['aggressive'],
        flavor: 'A prehistoric saber cat prowls the permafrost with ancient, hungry eyes.'
    },
    alligator: {
        id: 'alligator', name: 'Alligator', emoji: '🐊', tier: 'epic',
        payoutMin: 285, payoutMax: 460, xp: 150,
        specialDrop: { itemId: 'gator_hide', name: 'Gator Hide', chance: 0.13 },
        zones: ['murky_swamp'], traits: ['armored', 'aggressive'],
        flavor: 'An alligator lurches from the black water in an explosive ambush.'
    },
    panther: {
        id: 'panther', name: 'Panther', emoji: '🐆', tier: 'epic',
        payoutMin: 315, payoutMax: 510, xp: 150,
        specialDrop: { itemId: 'shadow_pelt', name: 'Shadow Pelt', chance: 0.11 },
        zones: ['murky_swamp', 'legendary_peaks'], traits: ['elusive'],
        flavor: 'A jet-black panther drops from the canopy without making a sound.'
    },
    dire_wolf: {
        id: 'dire_wolf', name: 'Dire Wolf', emoji: '🐺', tier: 'epic',
        payoutMin: 330, payoutMax: 535, xp: 150,
        specialDrop: { itemId: 'dire_wolf_fang', name: 'Dire Wolf Fang', chance: 0.14 },
        zones: ['legendary_peaks'], traits: ['pack_hunter', 'aggressive'],
        flavor: 'A Dire Wolf the size of a pony emerges from the alpine mist, eyes burning red.'
    },
    alpha_bear: {
        id: 'alpha_bear', name: 'Alpha Bear', emoji: '🐻', tier: 'epic',
        payoutMin: 340, payoutMax: 540, xp: 150,
        specialDrop: { itemId: 'primal_claw', name: 'Primal Claw', chance: 0.15 },
        zones: ['legendary_peaks'], traits: ['aggressive', 'giant', 'enraged'],
        flavor: 'An Alpha Bear, scarred from a hundred battles, roars down the mountainside.'
    },

    // ── LEGENDARY ────────────────────────────────────────────────────────────
    snow_leopard: {
        id: 'snow_leopard', name: 'Snow Leopard', emoji: '🐆', tier: 'legendary',
        payoutMin: 650, payoutMax: 1100, xp: 500,
        specialDrop: { itemId: 'spirit_pelt', name: 'Spirit Pelt', chance: 0.20 },
        zones: ['arctic_tundra', 'legendary_peaks'], traits: ['elusive', 'spectral'],
        flavor: 'A ghostly snow leopard materialises from the blizzard.'
    },
    giant_elk: {
        id: 'giant_elk', name: 'Giant Elk', emoji: '🦌', tier: 'legendary',
        payoutMin: 850, payoutMax: 1300, xp: 500,
        specialDrop: { itemId: 'megaloceros_crown', name: 'Megaloceros Crown', chance: 0.18 },
        zones: ['legendary_peaks'], traits: ['giant', 'armored'],
        flavor: 'An ancient Giant Elk stands like a living monument in the mist.'
    },
    golden_fox: {
        id: 'golden_fox', name: 'Golden Fox', emoji: '🦊', tier: 'legendary',
        payoutMin: 750, payoutMax: 1150, xp: 500,
        specialDrop: { itemId: 'golden_fur', name: 'Golden Fur', chance: 1.00 },
        zones: ['legendary_peaks', 'beginner_forest'], traits: ['elusive'],
        flavor: 'A shimmering golden fox vanishes between the trees in a flash of light.'
    },
    white_wolf: {
        id: 'white_wolf', name: 'White Wolf', emoji: '🐺', tier: 'legendary',
        payoutMin: 800, payoutMax: 1200, xp: 500,
        specialDrop: { itemId: 'spirit_essence', name: 'Spirit Essence', chance: 0.25 },
        zones: ['legendary_peaks', 'arctic_tundra'], traits: ['spectral', 'pack_hunter'],
        flavor: 'A spectral white wolf howls beneath the aurora borealis.'
    },
    obsidian_stag: {
        id: 'obsidian_stag', name: 'Obsidian Stag', emoji: '🦌', tier: 'legendary',
        payoutMin: 700, payoutMax: 1150, xp: 500,
        specialDrop: { itemId: 'obsidian_antler', name: 'Obsidian Antler', chance: 0.20 },
        zones: ['legendary_peaks'], traits: ['armored', 'giant'],
        flavor: 'An Obsidian Stag with jet-black antlers like volcanic glass glares from the summit.'
    },
    storm_hawk: {
        id: 'storm_hawk', name: 'Storm Hawk', emoji: '🦅', tier: 'legendary',
        payoutMin: 780, payoutMax: 1200, xp: 500,
        specialDrop: { itemId: 'storm_feather', name: 'Storm Feather', chance: 0.22 },
        zones: ['legendary_peaks'], traits: ['elusive', 'giant'],
        flavor: 'A Storm Hawk the size of a horse shrieks as lightning crackles across its wingspan.'
    },
    fire_lynx: {
        id: 'fire_lynx', name: 'Fire Lynx', emoji: '🐈', tier: 'legendary',
        payoutMin: 820, payoutMax: 1280, xp: 500,
        specialDrop: { itemId: 'ember_fang', name: 'Ember Fang', chance: 0.22 },
        zones: ['legendary_peaks'], traits: ['aggressive', 'enraged'],
        flavor: 'A Fire Lynx with smoldering eyes and an ashen coat stalks the lava fields.'
    },

    // ── EVENT / MYTHICAL ─────────────────────────────────────────────────────
    dire_bear: {
        id: 'dire_bear', name: 'Dire Bear', emoji: '🐻', tier: 'event',
        payoutMin: 1600, payoutMax: 2800, xp: 1000,
        specialDrop: { itemId: 'ancient_claw', name: 'Ancient Claw', chance: 0.30 },
        zones: ['murky_swamp'], traits: ['aggressive', 'giant', 'enraged'],
        flavor: 'An enormous prehistoric bear erupts from the swamp fog with a thunderous roar!'
    },
    thunderbird: {
        id: 'thunderbird', name: 'Thunderbird', emoji: '⚡', tier: 'event',
        payoutMin: 2200, payoutMax: 3600, xp: 1000,
        specialDrop: { itemId: 'thunderfeather', name: 'Thunderfeather', chance: 0.35 },
        zones: ['all'], traits: ['spectral', 'elusive', 'giant'],
        flavor: 'Lightning splits the sky as a titanic Thunderbird descends from the clouds!'
    },
    ghost_stag: {
        id: 'ghost_stag', name: 'Ghost Stag', emoji: '👻', tier: 'event',
        payoutMin: 1900, payoutMax: 3100, xp: 1000,
        specialDrop: { itemId: 'spectral_bone', name: 'Spectral Bone', chance: 0.40 },
        zones: ['all'], traits: ['spectral', 'elusive'],
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
    HUNT_COOLDOWN_MS:        45_000,        // 45 seconds between hunts
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
    PITY_CONSECUTIVE_FAILS:  4,             // pity starts on the Nth straight fail, +15% per further fail, max 4 stacks
    PITY_BONUS_PER_STACK:    0.15,
    RARE_PITY_GUARANTEE:     50             // sinceRare threshold for guaranteed rare+
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

// ─── MATERIAL NAMES ──────────────────────────────────────────────────────────

const MATERIAL_NAMES = {
    rabbits_foot:       "Rabbit's Foot",
    acorn_cache:        'Acorn Cache',
    feather:            'Feather',
    down_feather:       'Down Feather',
    antler_fragment:    'Antler Fragment',
    tusk_shard:         'Tusk Shard',
    badger_pelt:        'Badger Pelt',
    beaver_pelt:        'Beaver Pelt',
    coyote_fang:        'Coyote Fang',
    wolf_pelt:          'Wolf Pelt',
    elk_antler:         'Grand Antler',
    lynx_fang:          'Lynx Fang',
    eagle_talon:        'Eagle Talon',
    mountain_horn:      'Mountain Horn',
    bear_claw:          'Bear Claw',
    moose_rack:         'Moose Rack',
    lion_tooth:         "Lion's Tooth",
    wolverine_fur:      'Wolverine Fur',
    spirit_pelt:        'Spirit Pelt',
    megaloceros_crown:  'Megaloceros Crown',
    golden_fur:         'Golden Fur',
    spirit_essence:     'Spirit Essence',
    ancient_claw:       'Ancient Claw',
    thunderfeather:     'Thunderfeather',
    spectral_bone:      'Spectral Bone',
    bandit_mask:        'Bandit Mask',
    striped_pelt:       'Striped Pelt',
    crow_feather:       'Crow Feather',
    slick_skin:         'Slick Skin',
    opossum_pelt:       'Opossum Pelt',
    hardwood_chip:      'Hardwood Chip',
    jackrabbit_foot:    "Jackrabbit's Foot",
    scavenger_feather:  'Scavenger Feather',
    sand_pelt:          'Sand Pelt',
    venom_sac:          'Venom Sac',
    hyena_fang:         'Hyena Fang',
    caribou_antler:     'Caribou Antler',
    arctic_fox_pelt:    'Arctic Fox Pelt',
    snowy_feather:      'Snowy Feather',
    thick_hide:         'Thick Hide',
    polar_claw:         'Polar Claw',
    saber_fang:         'Saber Fang',
    marsh_feather:      'Marsh Feather',
    hog_tusk:           'Hog Tusk',
    swamp_gland:        'Swamp Gland',
    cottonmouth_venom:  'Cottonmouth Venom',
    gator_hide:         'Gator Hide',
    shadow_pelt:        'Shadow Pelt',
    ram_horn:           'Ram Horn',
    dire_wolf_fang:     'Dire Wolf Fang',
    primal_claw:        'Primal Claw',
    obsidian_antler:    'Obsidian Antler',
    storm_feather:      'Storm Feather',
    ember_fang:         'Ember Fang',
    scorpion_claw:      'Scorpion Claw',
    mammoth_tusk:       'Mammoth Tusk',
    swamp_scale:        'Swamp Scale',
    ancient_relic:      'Ancient Relic'
};

// ─── CRAFTING RECIPES ─────────────────────────────────────────────────────────

const CRAFT_RECIPES = {
    basic_bait_3x: {
        id: 'basic_bait_3x', name: 'Basic Bait ×3', emoji: '🪱',
        description: "Craft 3 Basic Bait from Rabbit's Feet",
        ingredients: [{ material: 'rabbits_foot', qty: 3 }],
        output: { type: 'consumable', id: 'basic_bait', qty: 3 }
    },
    premium_bait_1x: {
        id: 'premium_bait_1x', name: 'Premium Bait ×1', emoji: '🎣',
        description: 'Craft Premium Bait from rare trophies',
        ingredients: [
            { material: 'antler_fragment', qty: 2 },
            { material: 'wolf_pelt',       qty: 1 }
        ],
        output: { type: 'consumable', id: 'premium_bait', qty: 1 }
    },
    luck_charm_1x: {
        id: 'luck_charm_1x', name: 'Luck Charm ×1', emoji: '🍀',
        description: 'Craft a Luck Charm from lucky drops',
        ingredients: [
            { material: 'rabbits_foot', qty: 3 },
            { material: 'coyote_fang',  qty: 2 }
        ],
        output: { type: 'consumable', id: 'luck_charm', qty: 1 }
    },
    stamina_tonic_1x: {
        id: 'stamina_tonic_1x', name: 'Stamina Tonic ×1', emoji: '⚡',
        description: 'Brew a Stamina Tonic from natural ingredients',
        ingredients: [
            { material: 'acorn_cache', qty: 3 },
            { material: 'feather',     qty: 2 }
        ],
        output: { type: 'consumable', id: 'stamina_tonic', qty: 1 }
    },
    xp_scroll_1x: {
        id: 'xp_scroll_1x', name: 'XP Scroll ×1', emoji: '📜',
        description: 'Craft an XP Scroll from rare trophy materials',
        ingredients: [
            { material: 'elk_antler',  qty: 1 },
            { material: 'eagle_talon', qty: 1 }
        ],
        output: { type: 'consumable', id: 'xp_scroll', qty: 1 }
    },
    hunters_focus_3x: {
        id: 'hunters_focus_3x', name: "Hunter's Focus ×3", emoji: '🎯',
        description: "Craft 3 Hunter's Focus from predator fangs",
        ingredients: [
            { material: 'lynx_fang',   qty: 1 },
            { material: 'coyote_fang', qty: 2 }
        ],
        output: { type: 'consumable', id: 'hunters_focus', qty: 3 }
    },
    repair_kit_small_2x: {
        id: 'repair_kit_small_2x', name: 'Repair Kit (Small) ×2', emoji: '🔧',
        description: 'Craft 2 small repair kits from animal pelts',
        ingredients: [
            { material: 'badger_pelt', qty: 2 },
            { material: 'beaver_pelt', qty: 1 }
        ],
        output: { type: 'consumable', id: 'repair_kit_small', qty: 2 }
    },
    repair_kit_large_1x: {
        id: 'repair_kit_large_1x', name: 'Repair Kit (Large) ×1', emoji: '🔨',
        description: 'Craft a large repair kit from epic trophies',
        ingredients: [
            { material: 'bear_claw',  qty: 1 },
            { material: 'moose_rack', qty: 1 }
        ],
        output: { type: 'consumable', id: 'repair_kit_large', qty: 1 }
    },
    iron_shot_40x: {
        id: 'iron_shot_40x', name: 'Iron Shot ×40', emoji: '🔶',
        description: 'Forge 40 iron rounds from bone and tusk',
        ingredients: [
            { material: 'antler_fragment', qty: 2 },
            { material: 'tusk_shard',      qty: 1 }
        ],
        output: { type: 'ammo', id: 'iron_shot', qty: 40 }
    },
    steel_shot_40x: {
        id: 'steel_shot_40x', name: 'Steel Shot ×40', emoji: '⚫',
        description: 'Forge 40 steel rounds from durable pelts',
        ingredients: [
            { material: 'wolf_pelt',   qty: 2 },
            { material: 'badger_pelt', qty: 1 }
        ],
        output: { type: 'ammo', id: 'steel_shot', qty: 40 }
    },
    lucky_paw: {
        id: 'lucky_paw', name: 'Lucky Paw', emoji: '🐾',
        description: 'A permanent upgrade granting +1% critical hit chance',
        ingredients: [
            { material: 'rabbits_foot',   qty: 5 },
            { material: 'golden_fur',     qty: 1 },
            { material: 'spirit_essence', qty: 1 }
        ],
        output: { type: 'permanent', id: 'luckyPaw' },
        unique: true
    }
};

// ─── HUNT DAILY QUEST TEMPLATES ───────────────────────────────────────────────

const HUNT_QUEST_TEMPLATES = [
    {
        id: 'hq_hunt5',   name: 'First Outing',      emoji: '🎯',
        description: 'Complete 5 hunts',
        type: 'total_hunts', target: 5,
        reward: { coins: 200, xp: 50 }, minLevel: 1
    },
    {
        id: 'hq_hunt15',  name: 'Dedicated Hunter',   emoji: '🏹',
        description: 'Complete 15 hunts',
        type: 'total_hunts', target: 15,
        reward: { coins: 500, xp: 150 }, minLevel: 1
    },
    {
        id: 'hq_rare3',   name: 'Trophy Hunter',      emoji: '⭐',
        description: 'Kill 3 rare (or better) animals',
        type: 'rare_plus_kills', target: 3,
        reward: { coins: 300, xp: 100 }, minLevel: 1
    },
    {
        id: 'hq_epic2',   name: 'Epic Chase',         emoji: '💜',
        description: 'Kill 2 epic animals',
        type: 'epic_plus_kills', target: 2,
        reward: { coins: 600, xp: 200 }, minLevel: 15
    },
    {
        id: 'hq_leg1',    name: 'Legend Seeker',      emoji: '✨',
        description: 'Kill 1 legendary animal',
        type: 'legendary_plus_kills', target: 1,
        reward: { coins: 1000, xp: 300 }, minLevel: 25
    },
    {
        id: 'hq_crit5',   name: 'Critical Eye',       emoji: '🎯',
        description: 'Land 5 critical hits',
        type: 'crits', target: 5,
        reward: { coins: 350, xp: 100 }, minLevel: 1
    },
    {
        id: 'hq_earn1k',  name: 'Bounty Run',         emoji: '💰',
        description: 'Earn 1,000 coins from hunting',
        type: 'earn_coins', target: 1000,
        reward: { coins: 250, xp: 75 }, minLevel: 1
    },
    {
        id: 'hq_earn5k',  name: 'Big Haul',           emoji: '💸',
        description: 'Earn 5,000 coins from hunting',
        type: 'earn_coins', target: 5000,
        reward: { coins: 800, xp: 200 }, minLevel: 10
    },
    {
        id: 'hq_mat3',    name: 'Collector',          emoji: '🪨',
        description: 'Collect 3 crafting material drops',
        type: 'material_drops', target: 3,
        reward: { coins: 400, xp: 125 }, minLevel: 1
    },
    {
        id: 'hq_streak5', name: 'On a Roll',          emoji: '🔥',
        description: 'Succeed on 5 consecutive hunts without failing',
        type: 'success_streak', target: 5,
        reward: { coins: 450, xp: 150 }, minLevel: 1
    },
    {
        id: 'hq_desert5', name: 'Desert Expedition',  emoji: '🏜️',
        description: 'Complete 5 hunts in the Desert Wastes',
        type: 'zone_hunts', zone: 'desert_wastes', target: 5,
        reward: { coins: 300, xp: 100 }, minLevel: 10
    },
    {
        id: 'hq_arctic5', name: 'Frozen Frontiers',   emoji: '🏔️',
        description: 'Complete 5 hunts in the Arctic Tundra',
        type: 'zone_hunts', zone: 'arctic_tundra', target: 5,
        reward: { coins: 500, xp: 150 }, minLevel: 20
    },
    {
        id: 'hq_swamp5',  name: 'Into the Murk',      emoji: '🌿',
        description: 'Complete 5 hunts in the Murky Swamp',
        type: 'zone_hunts', zone: 'murky_swamp', target: 5,
        reward: { coins: 700, xp: 200 }, minLevel: 30
    },
    {
        id: 'hq_peaks5',  name: 'Peak Performance',   emoji: '⛰️',
        description: 'Complete 5 hunts in the Legendary Peaks',
        type: 'zone_hunts', zone: 'legendary_peaks', target: 5,
        reward: { coins: 1200, xp: 350 }, minLevel: 50
    }
];

// ─── TROPHY QUALITY TIERS ────────────────────────────────────────────────────

const TROPHY_QUALITIES = [
    { id: 'poor',     label: 'Poor',     emoji: '🟤', multiplier: 0.70 },
    { id: 'normal',   label: 'Normal',   emoji: '⬜', multiplier: 1.00 },
    { id: 'good',     label: 'Good',     emoji: '🟢', multiplier: 1.20 },
    { id: 'pristine', label: 'Pristine', emoji: '🔷', multiplier: 1.50 },
    { id: 'mythic',   label: 'Mythic',   emoji: '🟣', multiplier: 2.50 },
];

// ── Apex encounters (Issue: interactive hunts) ───────────────────────────────
// After bringing down rare+ prey, its apex pack-leader may appear — a 3-phase
// choice fight mirroring the fishing boss pattern. Each apex has a hidden
// strategy players learn over time: match its moves, hold your ground, or
// wait it out. 'safe' choices never cost nerve but only the correct choice
// counts toward the reward.
const APEX_TYPES = {
    dire_alpha: {
        name: 'Dire Alpha',
        emoji: '🐺',
        strategy: 'match', // mirror its feints
        phases: [
            {
                hint: '**THE DIRE ALPHA** feints LEFT, hackles raised!',
                choices: {
                    match: { label: '🎯 Mirror it — sidestep LEFT', risk: 'high' },
                    hold:  { label: '🛑 Stand your ground',          risk: 'high' },
                    safe:  { label: '🌿 Back away slowly',           risk: 'none' }
                },
                correct: 'match'
            },
            {
                hint: 'It lunges RIGHT, snapping at your flank!',
                choices: {
                    match: { label: '🎯 Pivot RIGHT with it',  risk: 'high' },
                    hold:  { label: '🛑 Brace for the hit',    risk: 'high' },
                    safe:  { label: '🌿 Give ground',          risk: 'none' }
                },
                correct: 'match'
            },
            {
                hint: '**It rears for a final pounce** — read the angle.',
                choices: {
                    match: { label: '💪 Strike as it commits',     risk: 'high' },
                    hold:  { label: '🛑 Plant and counter',        risk: 'high' },
                    safe:  { label: '🌿 Wait for an opening',      risk: 'none' }
                },
                correct: 'match'
            }
        ]
    },
    phantom_stag: {
        name: 'Phantom Stag',
        emoji: '🦌',
        strategy: 'safe', // it cannot be forced — patience wins
        phases: [
            {
                hint: 'The **Phantom Stag** flickers between the trees — your eyes can\'t track it!',
                choices: {
                    match: { label: '🎯 Chase the afterimage',  risk: 'high' },
                    hold:  { label: '🛑 Take the shot anyway',  risk: 'high' },
                    safe:  { label: '🌿 Stay still and watch',  risk: 'none' }
                },
                correct: 'safe'
            },
            {
                hint: 'It freezes… antlers shimmering… then it\'s somewhere else entirely.',
                choices: {
                    match: { label: '🎯 Swing to the new spot', risk: 'high' },
                    hold:  { label: '🛑 Hold your aim',         risk: 'high' },
                    safe:  { label: '🌿 Lower your weapon',     risk: 'none' }
                },
                correct: 'safe'
            },
            {
                hint: 'The stag steps into a moonbeam and **looks straight at you**.',
                choices: {
                    match: { label: '🎯 Take the shot NOW',      risk: 'high' },
                    hold:  { label: '🛑 Steady... steady...',    risk: 'high' },
                    safe:  { label: '🌿 Let it come closer',     risk: 'none' }
                },
                correct: 'safe'
            }
        ]
    },
    ironhide_boar: {
        name: 'Ironhide Boar',
        emoji: '🐗',
        strategy: 'hold', // it only respects an unmoving hunter
        phases: [
            {
                hint: '**THE IRONHIDE BOAR** charges head-on, tusks down!',
                choices: {
                    match: { label: '🎯 Dodge and strike',     risk: 'high' },
                    hold:  { label: '🛑 Plant your feet',      risk: 'high' },
                    safe:  { label: '🌿 Dive clear',           risk: 'none' }
                },
                correct: 'hold'
            },
            {
                hint: 'It wheels around, pawing the dirt for another charge!',
                choices: {
                    match: { label: '🎯 Flank it',             risk: 'high' },
                    hold:  { label: '🛑 Hold the line',        risk: 'high' },
                    safe:  { label: '🌿 Put a tree between you', risk: 'none' }
                },
                correct: 'hold'
            },
            {
                hint: '**Its armored hide is cracked** — it charges one last time.',
                choices: {
                    match: { label: '🎯 Sidestep and slash',   risk: 'high' },
                    hold:  { label: '🛑 Meet it head-on',      risk: 'high' },
                    safe:  { label: '🌿 Stand aside',          risk: 'none' }
                },
                correct: 'hold'
            }
        ]
    }
};

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
    ANIMAL_TRAITS,
    HUNTER_LEVELS,
    TIER_COLORS,
    LIMITS,
    PRESTIGE_BONUSES,
    MATERIAL_NAMES,
    CRAFT_RECIPES,
    HUNT_QUEST_TEMPLATES,
    TROPHY_QUALITIES,
    APEX_TYPES
};
