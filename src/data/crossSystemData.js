'use strict';

// ─── CROSS-SYSTEM CONSUMABLES ────────────────────────────────────────────────
// Items crafted by combining materials from multiple systems.

const CROSS_CONSUMABLES = {
    predators_eye: {
        id: 'predators_eye', name: "Predator's Eye", emoji: '👁️',
        type: 'fish_bait', castsLeft: 3,
        effect: { tierShift: 0.30 },
        description: '+30% rare fish tier chance for 3 casts',
        maxStack: 3,
        system: 'fishing'
    },
    abyssal_lure: {
        id: 'abyssal_lure', name: 'Abyssal Lure', emoji: '🌑',
        type: 'fish_bait', castsLeft: 3,
        effect: { legendaryShift: 0.15, epicShift: 0.10 },
        description: '+15% legendary, +10% epic chance for 3 casts',
        maxStack: 2,
        system: 'fishing'
    },
    reinforced_trap: {
        id: 'reinforced_trap', name: 'Reinforced Trap', emoji: '🪤',
        type: 'mine_immunity', minesLeft: 10,
        description: 'Blocks cave-ins for the next 10 mines',
        maxStack: 3,
        system: 'mining'
    }
};

// ─── CROSS-SYSTEM CRAFTING RECIPES ───────────────────────────────────────────
// Each ingredient has a `source` field: 'hunt' | 'fish' | 'mine'

const CROSS_CRAFT_RECIPES = {
    predators_eye_1x: {
        id: 'predators_eye_1x', name: "Predator's Eye ×1", emoji: '👁️',
        description: "Hunt trophies infused into a fishing lure (+30% rare fish, 3 casts)",
        ingredients: [
            { material: 'eagle_talon',  qty: 5, source: 'hunt' },
            { material: 'spirit_pelt',  qty: 2, source: 'hunt' }
        ],
        output: { type: 'fish_consumable', id: 'predators_eye', qty: 1 }
    },
    reinforced_trap_1x: {
        id: 'reinforced_trap_1x', name: 'Reinforced Trap ×1', emoji: '🪤',
        description: "Claws and iron filings forged into cave-in protection (blocks 10 cave-ins)",
        ingredients: [
            { material: 'bear_claw',   qty: 3, source: 'hunt' },
            { material: 'iron_filing', qty: 5, source: 'mine' }
        ],
        output: { type: 'mine_immunity', id: 'reinforced_trap', qty: 1 }
    },
    precision_scope_1x: {
        id: 'precision_scope_1x', name: 'Precision Scope', emoji: '🔭',
        description: "Rare gems ground into a permanent rifle scope (+2% rarity boost on all hunts)",
        ingredients: [
            { material: 'raw_diamond',  qty: 10, source: 'mine' },
            { material: 'mythril_dust', qty: 5,  source: 'mine' }
        ],
        output: { type: 'hunt_permanent', id: 'precisionScope' },
        unique: true
    },
    abyssal_lure_1x: {
        id: 'abyssal_lure_1x', name: 'Abyssal Lure ×1', emoji: '🌑',
        description: "Spirit Essence shaped into a deep-sea lure (+15% legendary, +10% epic, 3 casts)",
        ingredients: [
            { material: 'spirit_essence', qty: 5, source: 'hunt' }
        ],
        output: { type: 'fish_consumable', id: 'abyssal_lure', qty: 1 }
    }
};

// ─── SKILL SYNERGY DEFINITIONS ───────────────────────────────────────────────

const SYNERGIES = {
    outdoorsman: {
        id: 'outdoorsman',
        name: 'Outdoorsman',
        emoji: '🌿',
        description: '+1 max stamina in both Hunting and Fishing',
        flavor: 'Time in the field trains body and mind.',
        requirements: { hunt: 30, fishing: 30 },
        bonuses: { huntStamina: 1, fishingStamina: 1 }
    },
    iron_will: {
        id: 'iron_will',
        name: 'Iron Will',
        emoji: '⚙️',
        description: 'Cave-ins are blocked when your pickaxe is below 50% durability',
        flavor: 'The hunter\'s survival instinct prevents the worst underground disasters.',
        requirements: { mining: 50, hunt: 50 },
        bonuses: { mineIronWill: true }
    },
    deep_prospector: {
        id: 'deep_prospector',
        name: 'Deep Prospector',
        emoji: '🪝',
        description: '+1 max stamina in both Fishing and Mining',
        flavor: 'Patience in the depths, whether water or stone, trains the same muscle.',
        requirements: { fishing: 30, mining: 30 },
        bonuses: { fishingStamina: 1, miningStamina: 1 }
    },
    artificer: {
        id: 'artificer',
        name: 'Artificer',
        emoji: '⚒️',
        description: '+5% ore yield and +1 max mining stamina',
        flavor: 'Those who forge know the earth\'s secrets better than anyone.',
        requirements: { mining: 50 },
        bonuses: { mineYieldPct: 0.05, miningStamina: 1 }
    },
    merchant: {
        id: 'merchant',
        name: 'Merchant',
        emoji: '💼',
        description: '+5% coins from /work and /crime when you have items in your inventory',
        flavor: 'A full bag and a sharp eye — the mark of someone who knows value.',
        requirements: { hunt: 20, fishing: 20, mining: 20 },
        bonuses: { workCrimeCoinPct: 0.05 }
    },
    wayfinder: {
        id: 'wayfinder',
        name: 'Wayfinder',
        emoji: '🧭',
        description: '+1 max stamina in both Exploration and Hunting',
        flavor: 'Reading the land and reading the prey are the same craft.',
        // Exploration's track tops out at 30, so 20 here is the same mid-track
        // commitment the 50-level systems ask for at 30.
        requirements: { hunt: 30, exploration: 20 },
        bonuses: { explorationStamina: 1, huntStamina: 1 }
    }
};

const SYNERGY_LIST = Object.values(SYNERGIES);

// How many "Permanent Stamina +1" shop items one player can stack. Mirrors the
// max on User.staminaUpgrades, and matches the other stackable permanent buys.
const MAX_STAMINA_UPGRADES = 3;

// The Wilderness district's server-wide yield bonus (see /invest). It lifts the
// payout of every gathering run — hunt, fish and mine each apply it, and their
// embeds each print it — so it is one number here rather than the five copies of
// `0.10` it was spread across (#892).
const WILDERNESS_YIELD_BONUS = 0.10;

module.exports = {
    CROSS_CONSUMABLES,
    CROSS_CRAFT_RECIPES,
    SYNERGIES,
    SYNERGY_LIST,
    MAX_STAMINA_UPGRADES,
    WILDERNESS_YIELD_BONUS
};
