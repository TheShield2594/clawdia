'use strict';

// ─── PICKAXE TIERS ───────────────────────────────────────────────────────────

const PICKAXE_TIERS = [
    {
        tier: 1, slug: 'wooden_pickaxe', name: 'Wooden Pickaxe', emoji: '🪵',
        cost: 500, baseDurability: 80, successRate: 0.45, rarityBoost: 0.00,
        requiresCharge: false, chargeType: null, chargeCost: 0,
        repairCostPer20: 80,
        description: 'A crude but sturdy wooden pickaxe. No blast charges needed.'
    },
    {
        tier: 2, slug: 'iron_pickaxe', name: 'Iron Pickaxe', emoji: '⛏️',
        cost: 2500, baseDurability: 120, successRate: 0.56, rarityBoost: 0.02,
        requiresCharge: true, chargeType: 'iron_blast', chargeCost: 5,
        repairCostPer20: 180,
        description: 'An iron pickaxe with solid heft and improved precision.'
    },
    {
        tier: 3, slug: 'steel_pickaxe', name: 'Steel Pickaxe', emoji: '🔩',
        cost: 8000, baseDurability: 160, successRate: 0.65, rarityBoost: 0.05,
        requiresCharge: true, chargeType: 'steel_blast', chargeCost: 10,
        repairCostPer20: 400,
        description: 'A hardened steel pickaxe for serious miners.'
    },
    {
        tier: 4, slug: 'diamond_pickaxe', name: 'Diamond Pickaxe', emoji: '💎',
        cost: 28000, baseDurability: 200, successRate: 0.74, rarityBoost: 0.09,
        requiresCharge: true, chargeType: 'explosive_charge', chargeCost: 15,
        repairCostPer20: 900,
        description: 'Diamond-tipped for deep-vein precision mining.'
    },
    {
        tier: 5, slug: 'void_pickaxe', name: 'Void Pickaxe', emoji: '🔮',
        cost: 90000, baseDurability: 250, successRate: 0.80, rarityBoost: 0.14,
        requiresCharge: true, chargeType: 'void_charge', chargeCost: 20,
        repairCostPer20: 2000,
        description: 'Forged from void matter. Passes through stone like smoke.'
    }
];

const PICKAXE_BY_SLUG = Object.fromEntries(PICKAXE_TIERS.map(p => [p.slug, p]));
const PICKAXE_BY_TIER = Object.fromEntries(PICKAXE_TIERS.map(p => [p.tier, p]));

// ─── PICKAXE UPGRADES ─────────────────────────────────────────────────────────

const PICKAXE_UPGRADES = {
    tempered_edge: {
        id: 'tempered_edge', name: 'Tempered Edge', emoji: '🔪',
        costMultiplier: 0.30,
        effect: { successBonus: 0.04 },
        description: '+4% success chance'
    },
    gem_lens: {
        id: 'gem_lens', name: 'Gem Lens', emoji: '🔭',
        costMultiplier: 0.30,
        effect: { rarityBonus: 0.03 },
        description: '+3% rarity boost'
    },
    reinforced_handle: {
        id: 'reinforced_handle', name: 'Reinforced Handle', emoji: '🛡️',
        costMultiplier: 0.25,
        effect: { durabilityReduction: 1 },
        description: 'Reduces durability loss by 1 per mine (minimum 1)'
    }
};

// ─── BLAST CHARGE PACKS ──────────────────────────────────────────────────────

const BLAST_PACKS = [
    {
        id: 'iron_blast_pack', name: 'Iron Blast (20)', emoji: '💥',
        cost: 90, chargeType: 'iron_blast', quantity: 20,
        description: 'Blast charges for Iron Pickaxe'
    },
    {
        id: 'steel_blast_pack', name: 'Steel Blast (20)', emoji: '💣',
        cost: 180, chargeType: 'steel_blast', quantity: 20,
        description: 'Blast charges for Steel Pickaxe'
    },
    {
        id: 'explosive_charge_pack', name: 'Explosive Charges (20)', emoji: '🧨',
        cost: 270, chargeType: 'explosive_charge', quantity: 20,
        description: 'Explosive charges for Diamond Pickaxe'
    },
    {
        id: 'void_charge_pack', name: 'Void Charges (20)', emoji: '🔮',
        cost: 360, chargeType: 'void_charge', quantity: 20,
        description: 'Void charges for Void Pickaxe'
    }
];

// ─── CONSUMABLES ─────────────────────────────────────────────────────────────

const CONSUMABLES = {
    ore_magnet: {
        id: 'ore_magnet', name: 'Ore Magnet', emoji: '🧲',
        cost: 80, type: 'magnet', minesLeft: 3,
        effect: { tierShift: 0.08 },
        description: '+8% rare tier chance for 3 mines',
        maxStack: 10
    },
    premium_magnet: {
        id: 'premium_magnet', name: 'Premium Magnet', emoji: '⚡',
        cost: 250, type: 'magnet', minesLeft: 3,
        effect: { tierShift: 0.15, epicShift: 0.05 },
        description: '+15% rare, +5% epic chance for 3 mines',
        maxStack: 5
    },
    miners_lamp: {
        id: 'miners_lamp', name: "Miner's Lamp", emoji: '🪔',
        cost: 150, type: 'lamp', minesLeft: 5,
        effect: { critBonus: 0.05, successBonus: 0.03 },
        description: '+5% crit, +3% success for 5 mines',
        maxStack: 5
    },
    miners_instinct: {
        id: 'miners_instinct', name: "Miner's Instinct", emoji: '🎯',
        cost: 60, type: 'instant', minesLeft: 1,
        effect: { successBonus: 0.10 },
        description: '+10% success chance for 1 mine',
        maxStack: 10
    },
    repair_kit_small: {
        id: 'repair_kit_small', name: 'Repair Kit (Small)', emoji: '🔧',
        cost: 120, type: 'repair', durabilityRestore: 20,
        description: 'Restores 20 durability to equipped pickaxe',
        maxStack: 5
    },
    repair_kit_large: {
        id: 'repair_kit_large', name: 'Repair Kit (Large)', emoji: '🔨',
        cost: 280, type: 'repair', durabilityRestore: 50,
        description: 'Restores 50 durability to equipped pickaxe',
        maxStack: 3
    },
    energy_tonic: {
        id: 'energy_tonic', name: 'Energy Tonic', emoji: '⚗️',
        cost: 200, type: 'stamina', staminaRestore: 3,
        description: 'Restores 3 stamina (max 2 uses per day)',
        maxStack: 5
    },
    xp_scroll: {
        id: 'xp_scroll', name: 'XP Scroll', emoji: '📜',
        cost: 180, type: 'instant', minesLeft: 1,
        effect: { xpMultiplier: 0.50 },
        description: '+50% XP on next mine',
        maxStack: 10
    }
};

// ─── MINE DEPTHS ─────────────────────────────────────────────────────────────

const DEPTHS = {
    surface_quarry: {
        id: 'surface_quarry', name: 'Surface Quarry', emoji: '🪨',
        unlockLevel: 1, unlockCost: 0, defaultUnlocked: true,
        difficultyMod: 0.00, payoutBonus: 0.00,
        tierWeights: { common: 52, uncommon: 30, rare: 13, epic: 4, legendary: 1, event: 0 },
        description: 'A sunlit open-pit quarry. Great for beginners.'
    },
    coal_tunnels: {
        id: 'coal_tunnels', name: 'Coal Tunnels', emoji: '🖤',
        unlockLevel: 10, unlockCost: 3000, defaultUnlocked: false,
        difficultyMod: -0.05, payoutBonus: 0.00,
        tierWeights: { common: 42, uncommon: 30, rare: 18, epic: 7, legendary: 2.5, event: 0.5 },
        description: 'Sooty tunnels that hide uncommon veins.'
    },
    iron_mines: {
        id: 'iron_mines', name: 'Iron Mines', emoji: '🔩',
        unlockLevel: 20, unlockCost: 12000, defaultUnlocked: false,
        difficultyMod: -0.08, payoutBonus: 0.00,
        tierWeights: { common: 35, uncommon: 28, rare: 22, epic: 11, legendary: 3.5, event: 0.5 },
        description: 'Deep iron deposits where rare gems can form.'
    },
    crystal_caves: {
        id: 'crystal_caves', name: 'Crystal Caves', emoji: '💠',
        unlockLevel: 30, unlockCost: 30000, defaultUnlocked: false,
        difficultyMod: -0.10, payoutBonus: 0.00,
        tierWeights: { common: 32, uncommon: 27, rare: 22, epic: 13, legendary: 5, event: 1 },
        description: 'Glittering caverns where crystals grow from every wall.'
    },
    the_abyss: {
        id: 'the_abyss', name: 'The Abyss', emoji: '🌑',
        unlockLevel: 50, unlockCost: 75000, defaultUnlocked: false,
        difficultyMod: -0.12, payoutBonus: 0.20,
        tierWeights: { common: 15, uncommon: 22, rare: 28, epic: 22, legendary: 12, event: 1 },
        description: 'A bottomless fissure of unimaginable riches. Master miners only.'
    }
};

const DEPTH_LIST = Object.values(DEPTHS);

// ─── ORES ─────────────────────────────────────────────────────────────────────

const ORES = {
    // ── COMMON ───────────────────────────────────────────────────────────────
    stone: {
        id: 'stone', name: 'Stone', emoji: '🪨', tier: 'common',
        payoutMin: 5, payoutMax: 12, xp: 8,
        specialDrop: { itemId: 'rock_fragment', name: 'Rock Fragment', chance: 0.03 },
        depths: ['all'],
        flavor: 'Ordinary stone, but every strike brings you closer to something greater.'
    },
    coal: {
        id: 'coal', name: 'Coal', emoji: '⬛', tier: 'common',
        payoutMin: 10, payoutMax: 25, xp: 10,
        specialDrop: { itemId: 'coal_dust', name: 'Coal Dust', chance: 0.04 },
        depths: ['all'],
        flavor: 'A thick coal seam runs through the rock face.'
    },
    copper: {
        id: 'copper', name: 'Copper Ore', emoji: '🟤', tier: 'common',
        payoutMin: 18, payoutMax: 38, xp: 10,
        specialDrop: { itemId: 'copper_flake', name: 'Copper Flake', chance: 0.05 },
        depths: ['surface_quarry', 'coal_tunnels', 'iron_mines'],
        flavor: 'Greenish copper veins snake through the stone.'
    },
    tin: {
        id: 'tin', name: 'Tin Ore', emoji: '⬜', tier: 'common',
        payoutMin: 22, payoutMax: 45, xp: 10,
        specialDrop: null,
        depths: ['surface_quarry', 'coal_tunnels'],
        flavor: 'Dull tin ore, useful in bulk.'
    },

    // ── UNCOMMON ─────────────────────────────────────────────────────────────
    iron: {
        id: 'iron', name: 'Iron Ore', emoji: '⚙️', tier: 'uncommon',
        payoutMin: 55, payoutMax: 110, xp: 25,
        specialDrop: { itemId: 'iron_filing', name: 'Iron Filing', chance: 0.08 },
        depths: ['all'],
        flavor: 'Dense iron ore runs in a thick dark vein.'
    },
    silver: {
        id: 'silver', name: 'Silver Ore', emoji: '🩶', tier: 'uncommon',
        payoutMin: 70, payoutMax: 130, xp: 25,
        specialDrop: { itemId: 'silver_dust', name: 'Silver Dust', chance: 0.07 },
        depths: ['coal_tunnels', 'iron_mines', 'crystal_caves'],
        flavor: 'Lustrous silver catches the light of your lamp.'
    },
    lead: {
        id: 'lead', name: 'Lead Ore', emoji: '🔵', tier: 'uncommon',
        payoutMin: 48, payoutMax: 95, xp: 25,
        specialDrop: { itemId: 'lead_slug', name: 'Lead Slug', chance: 0.06 },
        depths: ['coal_tunnels', 'iron_mines'],
        flavor: 'Heavy lead ore weighs down your haul.'
    },
    quartz: {
        id: 'quartz', name: 'Quartz Crystal', emoji: '🤍', tier: 'uncommon',
        payoutMin: 65, payoutMax: 120, xp: 25,
        specialDrop: { itemId: 'quartz_shard', name: 'Quartz Shard', chance: 0.08 },
        depths: ['surface_quarry', 'crystal_caves'],
        flavor: 'A perfect quartz formation juts from the wall.'
    },

    // ── RARE ─────────────────────────────────────────────────────────────────
    gold: {
        id: 'gold', name: 'Gold Ore', emoji: '🟡', tier: 'rare',
        payoutMin: 140, payoutMax: 240, xp: 75,
        specialDrop: { itemId: 'gold_nugget', name: 'Gold Nugget', chance: 0.09 },
        depths: ['all'],
        flavor: 'Glittering gold threads run through the rock like veins of fire.'
    },
    sapphire: {
        id: 'sapphire', name: 'Sapphire', emoji: '💙', tier: 'rare',
        payoutMin: 160, payoutMax: 280, xp: 75,
        specialDrop: { itemId: 'raw_sapphire', name: 'Raw Sapphire', chance: 0.07 },
        depths: ['iron_mines', 'crystal_caves', 'the_abyss'],
        flavor: 'A deep blue sapphire catches your eye amid grey stone.'
    },
    amethyst: {
        id: 'amethyst', name: 'Amethyst', emoji: '💜', tier: 'rare',
        payoutMin: 145, payoutMax: 250, xp: 75,
        specialDrop: { itemId: 'amethyst_chip', name: 'Amethyst Chip', chance: 0.08 },
        depths: ['crystal_caves', 'the_abyss'],
        flavor: 'Rich purple amethyst clusters bristle from the cavern wall.'
    },
    topaz: {
        id: 'topaz', name: 'Topaz', emoji: '🟠', tier: 'rare',
        payoutMin: 170, payoutMax: 290, xp: 75,
        specialDrop: { itemId: 'topaz_shard', name: 'Topaz Shard', chance: 0.07 },
        depths: ['iron_mines', 'crystal_caves'],
        flavor: 'A warm amber topaz gleams in the stone.'
    },

    // ── EPIC ─────────────────────────────────────────────────────────────────
    emerald: {
        id: 'emerald', name: 'Emerald', emoji: '💚', tier: 'epic',
        payoutMin: 310, payoutMax: 490, xp: 150,
        specialDrop: { itemId: 'raw_emerald', name: 'Raw Emerald', chance: 0.15 },
        depths: ['iron_mines', 'crystal_caves', 'the_abyss'],
        flavor: 'A flawless emerald, green as deep forest, buried in the dark.'
    },
    ruby: {
        id: 'ruby', name: 'Ruby', emoji: '🔴', tier: 'epic',
        payoutMin: 330, payoutMax: 530, xp: 150,
        specialDrop: { itemId: 'raw_ruby', name: 'Raw Ruby', chance: 0.13 },
        depths: ['crystal_caves', 'the_abyss'],
        flavor: 'A ruby blazes red, pulsing like an ember in the rock.'
    },
    obsidian: {
        id: 'obsidian', name: 'Obsidian', emoji: '🖤', tier: 'epic',
        payoutMin: 290, payoutMax: 460, xp: 150,
        specialDrop: { itemId: 'obsidian_chip', name: 'Obsidian Chip', chance: 0.12 },
        depths: ['crystal_caves', 'the_abyss'],
        flavor: 'Razor-sharp obsidian glass, formed from ancient lava.'
    },
    platinum: {
        id: 'platinum', name: 'Platinum Ore', emoji: '🌟', tier: 'epic',
        payoutMin: 350, payoutMax: 550, xp: 150,
        specialDrop: { itemId: 'platinum_dust', name: 'Platinum Dust', chance: 0.11 },
        depths: ['the_abyss'],
        flavor: 'Rare platinum gleams dully, worth more than its weight in gold.'
    },

    // ── LEGENDARY ────────────────────────────────────────────────────────────
    diamond: {
        id: 'diamond', name: 'Diamond', emoji: '💎', tier: 'legendary',
        payoutMin: 680, payoutMax: 1100, xp: 500,
        specialDrop: { itemId: 'raw_diamond', name: 'Raw Diamond', chance: 0.20 },
        depths: ['crystal_caves', 'the_abyss'],
        flavor: 'A perfect diamond, the hardest substance known, catches every light.'
    },
    dark_crystal: {
        id: 'dark_crystal', name: 'Dark Crystal', emoji: '🔮', tier: 'legendary',
        payoutMin: 820, payoutMax: 1280, xp: 500,
        specialDrop: { itemId: 'crystal_sliver', name: 'Crystal Sliver', chance: 0.18 },
        depths: ['the_abyss'],
        flavor: 'An impossible dark crystal that seems to absorb light itself.'
    },
    mythril: {
        id: 'mythril', name: 'Mythril Ore', emoji: '🔷', tier: 'legendary',
        payoutMin: 750, payoutMax: 1150, xp: 500,
        specialDrop: { itemId: 'mythril_dust', name: 'Mythril Dust', chance: 0.15 },
        depths: ['the_abyss'],
        flavor: 'Legendary mythril, lighter than steel and stronger than diamond.'
    },
    zenith_shard: {
        id: 'zenith_shard', name: 'Zenith Shard', emoji: '✨', tier: 'legendary',
        payoutMin: 900, payoutMax: 1400, xp: 500,
        specialDrop: { itemId: 'zenith_essence', name: 'Zenith Essence', chance: 0.15 },
        depths: ['the_abyss'],
        flavor: 'A shard of condensed starlight, fallen from somewhere beyond the sky.'
    },

    // ── EVENT / MYTHICAL ─────────────────────────────────────────────────────
    primordial_ore: {
        id: 'primordial_ore', name: 'Primordial Ore', emoji: '🌋', tier: 'event',
        payoutMin: 1800, payoutMax: 3000, xp: 1000,
        specialDrop: { itemId: 'primordial_ash', name: 'Primordial Ash', chance: 0.30 },
        depths: ['the_abyss'],
        flavor: 'Ore forged in the core of a newborn world, still radiating primal heat!'
    },
    celestial_fragment: {
        id: 'celestial_fragment', name: 'Celestial Fragment', emoji: '⭐', tier: 'event',
        payoutMin: 2400, payoutMax: 3800, xp: 1000,
        specialDrop: { itemId: 'stardust', name: 'Stardust', chance: 0.35 },
        depths: ['all'],
        flavor: 'A fragment of a fallen star, still warm and humming with cosmic energy!'
    },
    void_ore: {
        id: 'void_ore', name: 'Void Ore', emoji: '🌀', tier: 'event',
        payoutMin: 2000, payoutMax: 3200, xp: 1000,
        specialDrop: { itemId: 'void_essence', name: 'Void Essence', chance: 0.40 },
        depths: ['the_abyss'],
        flavor: 'Ore from the space between dimensions. It should not exist.'
    }
};

const ORES_BY_TIER = {};
for (const ore of Object.values(ORES)) {
    if (!ORES_BY_TIER[ore.tier]) ORES_BY_TIER[ore.tier] = [];
    ORES_BY_TIER[ore.tier].push(ore);
}

// ─── MINER LEVELS ─────────────────────────────────────────────────────────────

const MINER_LEVELS = [
    { level: 1,  xpRequired: 0,      title: 'Apprentice Miner',  unlocks: [] },
    { level: 2,  xpRequired: 100,    title: 'Apprentice Miner',  unlocks: [] },
    { level: 3,  xpRequired: 200,    title: 'Apprentice Miner',  unlocks: [] },
    { level: 4,  xpRequired: 300,    title: 'Apprentice Miner',  unlocks: [] },
    { level: 5,  xpRequired: 500,    title: 'Prospector',        unlocks: [] },
    { level: 6,  xpRequired: 700,    title: 'Prospector',        unlocks: [] },
    { level: 7,  xpRequired: 900,    title: 'Prospector',        unlocks: [] },
    { level: 8,  xpRequired: 1100,   title: 'Prospector',        unlocks: [] },
    { level: 9,  xpRequired: 1300,   title: 'Prospector',        unlocks: [] },
    { level: 10, xpRequired: 1500,   title: 'Miner',             unlocks: ['coal_tunnels'] },
    { level: 11, xpRequired: 1900,   title: 'Miner',             unlocks: [] },
    { level: 12, xpRequired: 2300,   title: 'Miner',             unlocks: [] },
    { level: 13, xpRequired: 2700,   title: 'Miner',             unlocks: [] },
    { level: 14, xpRequired: 3100,   title: 'Miner',             unlocks: [] },
    { level: 15, xpRequired: 3500,   title: 'Excavator',         unlocks: [] },
    { level: 16, xpRequired: 4200,   title: 'Excavator',         unlocks: [] },
    { level: 17, xpRequired: 4900,   title: 'Excavator',         unlocks: [] },
    { level: 18, xpRequired: 5600,   title: 'Excavator',         unlocks: [] },
    { level: 19, xpRequired: 6300,   title: 'Excavator',         unlocks: [] },
    { level: 20, xpRequired: 7000,   title: 'Shaft Miner',       unlocks: ['iron_mines'] },
    { level: 21, xpRequired: 8200,   title: 'Shaft Miner',       unlocks: [] },
    { level: 22, xpRequired: 9400,   title: 'Shaft Miner',       unlocks: [] },
    { level: 23, xpRequired: 10600,  title: 'Shaft Miner',       unlocks: [] },
    { level: 24, xpRequired: 11800,  title: 'Shaft Miner',       unlocks: [] },
    { level: 25, xpRequired: 13000,  title: 'Deep Miner',        unlocks: [] },
    { level: 26, xpRequired: 14800,  title: 'Deep Miner',        unlocks: [] },
    { level: 27, xpRequired: 16600,  title: 'Deep Miner',        unlocks: [] },
    { level: 28, xpRequired: 18400,  title: 'Deep Miner',        unlocks: [] },
    { level: 29, xpRequired: 20200,  title: 'Deep Miner',        unlocks: [] },
    { level: 30, xpRequired: 22000,  title: 'Cave Expert',       unlocks: ['crystal_caves'] },
    { level: 31, xpRequired: 24300,  title: 'Cave Expert',       unlocks: [] },
    { level: 32, xpRequired: 26600,  title: 'Cave Expert',       unlocks: [] },
    { level: 33, xpRequired: 28900,  title: 'Cave Expert',       unlocks: [] },
    { level: 34, xpRequired: 31200,  title: 'Cave Expert',       unlocks: [] },
    { level: 35, xpRequired: 33500,  title: 'Cave Expert',       unlocks: [] },
    { level: 36, xpRequired: 35800,  title: 'Cave Expert',       unlocks: [] },
    { level: 37, xpRequired: 38100,  title: 'Cave Expert',       unlocks: [] },
    { level: 38, xpRequired: 40400,  title: 'Cave Expert',       unlocks: [] },
    { level: 39, xpRequired: 42700,  title: 'Cave Expert',       unlocks: [] },
    { level: 40, xpRequired: 45000,  title: 'Elite Miner',       unlocks: [] },
    { level: 41, xpRequired: 49500,  title: 'Elite Miner',       unlocks: [] },
    { level: 42, xpRequired: 54000,  title: 'Elite Miner',       unlocks: [] },
    { level: 43, xpRequired: 58500,  title: 'Elite Miner',       unlocks: [] },
    { level: 44, xpRequired: 63000,  title: 'Elite Miner',       unlocks: [] },
    { level: 45, xpRequired: 67500,  title: 'Elite Miner',       unlocks: [] },
    { level: 46, xpRequired: 72000,  title: 'Elite Miner',       unlocks: [] },
    { level: 47, xpRequired: 76500,  title: 'Elite Miner',       unlocks: [] },
    { level: 48, xpRequired: 81000,  title: 'Elite Miner',       unlocks: [] },
    { level: 49, xpRequired: 85500,  title: 'Elite Miner',       unlocks: [] },
    { level: 50, xpRequired: 90000,  title: 'Master Miner',      unlocks: ['the_abyss'] }
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
    MINE_COOLDOWN_MS:        30_000,
    INJURY_PENALTY_MS:       15 * 60_000,
    STAMINA_REGEN_MS:        6 * 60_000,
    MAX_STAMINA_BASE:        10,
    DAILY_WINDOW_MS:         24 * 3_600_000,
    DAILY_SOFT_CAP:          80_000,
    DAILY_HARD_CAP:          150_000,
    DIM_RETURNS_THRESHOLD_1: 60,
    DIM_RETURNS_THRESHOLD_2: 90,
    DIM_RETURNS_THRESHOLD_3: 120,
    MAX_CRIT_CHANCE:         0.25,
    ENERGY_TONICS_PER_DAY:   2,
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

// ─── MATERIAL NAMES ──────────────────────────────────────────────────────────

const MATERIAL_NAMES = {
    rock_fragment:   'Rock Fragment',
    coal_dust:       'Coal Dust',
    copper_flake:    'Copper Flake',
    iron_filing:     'Iron Filing',
    silver_dust:     'Silver Dust',
    lead_slug:       'Lead Slug',
    quartz_shard:    'Quartz Shard',
    gold_nugget:     'Gold Nugget',
    raw_sapphire:    'Raw Sapphire',
    amethyst_chip:   'Amethyst Chip',
    topaz_shard:     'Topaz Shard',
    raw_emerald:     'Raw Emerald',
    raw_ruby:        'Raw Ruby',
    obsidian_chip:   'Obsidian Chip',
    platinum_dust:   'Platinum Dust',
    raw_diamond:     'Raw Diamond',
    crystal_sliver:  'Crystal Sliver',
    mythril_dust:    'Mythril Dust',
    zenith_essence:  'Zenith Essence',
    primordial_ash:  'Primordial Ash',
    stardust:        'Stardust',
    void_essence:    'Void Essence'
};

// ─── CRAFTING RECIPES ─────────────────────────────────────────────────────────

const CRAFT_RECIPES = {
    ore_magnet_3x: {
        id: 'ore_magnet_3x', name: 'Ore Magnet ×3', emoji: '🧲',
        description: 'Craft 3 Ore Magnets from Rock Fragments',
        ingredients: [{ material: 'rock_fragment', qty: 4 }],
        output: { type: 'consumable', id: 'ore_magnet', qty: 3 }
    },
    premium_magnet_1x: {
        id: 'premium_magnet_1x', name: 'Premium Magnet ×1', emoji: '⚡',
        description: 'Craft a Premium Magnet from refined materials',
        ingredients: [
            { material: 'iron_filing',  qty: 2 },
            { material: 'gold_nugget',  qty: 1 }
        ],
        output: { type: 'consumable', id: 'premium_magnet', qty: 1 }
    },
    miners_lamp_1x: {
        id: 'miners_lamp_1x', name: "Miner's Lamp ×1", emoji: '🪔',
        description: "Craft a Miner's Lamp from crystal materials",
        ingredients: [
            { material: 'quartz_shard', qty: 3 },
            { material: 'copper_flake', qty: 2 }
        ],
        output: { type: 'consumable', id: 'miners_lamp', qty: 1 }
    },
    energy_tonic_1x: {
        id: 'energy_tonic_1x', name: 'Energy Tonic ×1', emoji: '⚗️',
        description: 'Brew an Energy Tonic from mineral compounds',
        ingredients: [
            { material: 'silver_dust', qty: 2 },
            { material: 'coal_dust',   qty: 3 }
        ],
        output: { type: 'consumable', id: 'energy_tonic', qty: 1 }
    },
    xp_scroll_1x: {
        id: 'xp_scroll_1x', name: 'XP Scroll ×1', emoji: '📜',
        description: 'Craft an XP Scroll from legendary gemstones',
        ingredients: [
            { material: 'raw_sapphire', qty: 1 },
            { material: 'amethyst_chip', qty: 1 }
        ],
        output: { type: 'consumable', id: 'xp_scroll', qty: 1 }
    },
    miners_instinct_3x: {
        id: 'miners_instinct_3x', name: "Miner's Instinct ×3", emoji: '🎯',
        description: "Craft 3 Miner's Instincts from gem chips",
        ingredients: [
            { material: 'topaz_shard', qty: 1 },
            { material: 'amethyst_chip', qty: 2 }
        ],
        output: { type: 'consumable', id: 'miners_instinct', qty: 3 }
    }
};

// ─── MINE QUEST TEMPLATES ────────────────────────────────────────────────────

const MINE_QUEST_TEMPLATES = [
    {
        id: 'mq_total_1',     name: 'Day in the Mines',        emoji: '⛏️',
        type: 'total_mines',  target: 10,  minLevel: 1,
        description: 'Mine 10 times.',
        reward: { coins: 200, xp: 50 }
    },
    {
        id: 'mq_total_2',     name: 'Hard at Work',            emoji: '🪨',
        type: 'total_mines',  target: 25,  minLevel: 5,
        description: 'Mine 25 times.',
        reward: { coins: 500, xp: 120 }
    },
    {
        id: 'mq_rare_1',      name: 'Gem Hunter',              emoji: '💎',
        type: 'rare_plus_finds', target: 5, minLevel: 1,
        description: 'Find 5 rare or better ores.',
        reward: { coins: 350, xp: 100 }
    },
    {
        id: 'mq_rare_2',      name: 'Precious Haul',           emoji: '💍',
        type: 'rare_plus_finds', target: 10, minLevel: 10,
        description: 'Find 10 rare or better ores.',
        reward: { coins: 700, xp: 200 }
    },
    {
        id: 'mq_epic_1',      name: 'Deep Vein',               emoji: '🔴',
        type: 'epic_plus_finds', target: 3, minLevel: 20,
        description: 'Find 3 epic or better ores.',
        reward: { coins: 600, xp: 180 }
    },
    {
        id: 'mq_legendary_1', name: 'Legend Seeker',           emoji: '✨',
        type: 'legendary_plus_finds', target: 1, minLevel: 30,
        description: 'Find 1 legendary or better ore.',
        reward: { coins: 800, xp: 300 }
    },
    {
        id: 'mq_crits_1',     name: 'Critical Strike',         emoji: '💥',
        type: 'crits',        target: 3,  minLevel: 1,
        description: 'Land 3 critical strikes while mining.',
        reward: { coins: 300, xp: 80 }
    },
    {
        id: 'mq_crits_2',     name: 'Strike Force',            emoji: '⚡',
        type: 'crits',        target: 8,  minLevel: 15,
        description: 'Land 8 critical strikes while mining.',
        reward: { coins: 600, xp: 160 }
    },
    {
        id: 'mq_coins_1',     name: 'Profitable Day',          emoji: '💰',
        type: 'earn_coins',   target: 2000, minLevel: 1,
        description: 'Earn 2,000 coins from mining.',
        reward: { coins: 400, xp: 100 }
    },
    {
        id: 'mq_coins_2',     name: 'Rich Vein',               emoji: '🏦',
        type: 'earn_coins',   target: 8000, minLevel: 20,
        description: 'Earn 8,000 coins from mining.',
        reward: { coins: 1200, xp: 300 }
    },
    {
        id: 'mq_materials_1', name: 'Collector',               emoji: '🎁',
        type: 'material_drops', target: 5, minLevel: 1,
        description: 'Get 5 special material drops.',
        reward: { coins: 350, xp: 90 }
    },
    {
        id: 'mq_streak_1',    name: 'On a Roll',               emoji: '🔥',
        type: 'success_streak', target: 5, minLevel: 1,
        description: 'Get 5 successful mines in a row.',
        reward: { coins: 500, xp: 150 }
    },
    {
        id: 'mq_depth_coal',  name: 'Tunnel Rat',              emoji: '🖤',
        type: 'depth_mines',  target: 8, minLevel: 10, depth: 'coal_tunnels',
        description: 'Mine 8 times in the Coal Tunnels.',
        reward: { coins: 400, xp: 120 }
    },
    {
        id: 'mq_depth_iron',  name: 'Iron Will',               emoji: '🔩',
        type: 'depth_mines',  target: 8, minLevel: 20, depth: 'iron_mines',
        description: 'Mine 8 times in the Iron Mines.',
        reward: { coins: 600, xp: 180 }
    },
    {
        id: 'mq_depth_crystal', name: 'Crystal Clear',         emoji: '💠',
        type: 'depth_mines',  target: 8, minLevel: 30, depth: 'crystal_caves',
        description: 'Mine 8 times in the Crystal Caves.',
        reward: { coins: 900, xp: 250 }
    },
    {
        id: 'mq_depth_abyss', name: 'Into the Void',           emoji: '🌑',
        type: 'depth_mines',  target: 5, minLevel: 50, depth: 'the_abyss',
        description: 'Mine 5 times in The Abyss.',
        reward: { coins: 1500, xp: 500 }
    }
];

module.exports = {
    PICKAXE_TIERS,
    PICKAXE_BY_SLUG,
    PICKAXE_BY_TIER,
    PICKAXE_UPGRADES,
    BLAST_PACKS,
    CONSUMABLES,
    DEPTHS,
    DEPTH_LIST,
    ORES,
    ORES_BY_TIER,
    MINER_LEVELS,
    TIER_COLORS,
    LIMITS,
    PRESTIGE_BONUSES,
    MATERIAL_NAMES,
    CRAFT_RECIPES,
    MINE_QUEST_TEMPLATES
};
