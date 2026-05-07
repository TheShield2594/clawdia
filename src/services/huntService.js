'use strict';

const {
    WEAPON_TIERS,
    WEAPON_BY_TIER,
    WEAPON_UPGRADES,
    ZONES,
    ANIMALS,
    ANIMALS_BY_TIER,
    HUNTER_LEVELS,
    LIMITS,
    PRESTIGE_BONUSES,
    HUNT_QUEST_TEMPLATES
} = require('../data/huntData');

const DAILY_QUEST_COUNT = 3;

// ─── INIT ────────────────────────────────────────────────────────────────────

/**
 * Ensure all hunt sub-fields exist on a user document.
 * Called once per command before any reads/writes to user.hunt.
 */
function ensureHuntData(user) {
    if (!user.hunt) {
        user.hunt = {};
    }
    const h = user.hunt;
    if (h.stamina            == null) h.stamina            = 10;
    if (h.staminaLastRegen   == null) h.staminaLastRegen   = null;
    if (h.staminaTonicsToday == null) h.staminaTonicsToday = 0;
    if (h.lastTonicDayReset  == null) h.lastTonicDayReset  = null;
    if (h.xp                 == null) h.xp                 = 0;
    if (h.level              == null) h.level              = 1;
    if (h.prestige           == null) h.prestige            = 0;
    if (h.lastHunt           == null) h.lastHunt            = null;
    if (h.injuryUntil        == null) h.injuryUntil         = null;
    if (h.activeZone         == null) h.activeZone          = 'beginner_forest';
    if (!Array.isArray(h.unlockedZones))      h.unlockedZones      = ['beginner_forest'];
    if (h.equippedWeaponIndex == null) h.equippedWeaponIndex = -1;
    if (!Array.isArray(h.weapons))            h.weapons            = [];
    if (!h.ammo)         h.ammo         = {};
    if (!h.consumables)  h.consumables  = {};
    if (!h.materials)    h.materials    = {};
    if (h.activeBait           == null) h.activeBait           = null;
    if (h.activeBaitHuntsLeft  == null) h.activeBaitHuntsLeft  = 0;
    if (h.activeCharm          == null) h.activeCharm          = null;
    if (h.activeCharmHuntsLeft == null) h.activeCharmHuntsLeft = 0;
    if (h.activeFocus          == null) h.activeFocus          = false;
    if (h.activeXpScroll       == null) h.activeXpScroll       = false;
    if (h.luckyPaw             == null) h.luckyPaw             = false;
    if (h.totalHunts           == null) h.totalHunts           = 0;
    if (h.successfulHunts      == null) h.successfulHunts      = 0;
    if (h.totalEarned          == null) h.totalEarned          = 0;
    if (h.legendaryKills       == null) h.legendaryKills       = 0;
    if (h.eventKills           == null) h.eventKills           = 0;
    if (h.bestPayout           == null) h.bestPayout           = 0;
    if (h.consecutiveFails     == null) h.consecutiveFails     = 0;
    if (h.dailyCoins           == null) h.dailyCoins           = 0;
    if (h.dailyHunts           == null) h.dailyHunts           = 0;
    if (h.dailyWindowStart     == null) h.dailyWindowStart     = null;

    // Ensure beginner_forest is always unlocked
    if (!h.unlockedZones.includes('beginner_forest')) {
        h.unlockedZones.push('beginner_forest');
    }
    // Mark the subdoc as modified so Mongoose saves nested changes
    user.markModified('hunt');
}

// ─── STAMINA ─────────────────────────────────────────────────────────────────

function getMaxStamina(user) {
    const prestige = user.hunt?.prestige ?? 0;
    const bonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)]?.staminaBonus ?? 0;
    return LIMITS.MAX_STAMINA_BASE + bonus;
}

/**
 * Regenerates stamina based on elapsed time since last regen tick.
 * Preserves sub-interval remainder so progress isn't lost.
 * Mutates user.hunt in place.
 */
function applyStaminaRegen(user) {
    const h = user.hunt;
    const max = getMaxStamina(user);
    if (h.stamina >= max) {
        h.stamina = max;
        // Reset the clock so accumulated "full" time doesn't grant free regen later
        h.staminaLastRegen = new Date();
        user.markModified('hunt');
        return;
    }
    if (!h.staminaLastRegen) {
        h.staminaLastRegen = new Date();
        user.markModified('hunt');
        return;
    }
    const elapsed = Date.now() - h.staminaLastRegen.getTime();
    const intervals = Math.floor(elapsed / LIMITS.STAMINA_REGEN_MS);
    if (intervals <= 0) return;

    h.stamina = Math.min(max, h.stamina + intervals);
    // Advance lastRegen by exactly the intervals consumed (keeps remainder)
    h.staminaLastRegen = new Date(h.staminaLastRegen.getTime() + intervals * LIMITS.STAMINA_REGEN_MS);
    user.markModified('hunt');
}

/** Returns ms until next stamina point regenerates, or 0 if already full. */
function msUntilNextStamina(user) {
    const h = user.hunt;
    const max = getMaxStamina(user);
    if (h.stamina >= max) return 0;
    if (!h.staminaLastRegen) return LIMITS.STAMINA_REGEN_MS;
    const elapsed = Date.now() - h.staminaLastRegen.getTime();
    return Math.max(0, LIMITS.STAMINA_REGEN_MS - (elapsed % LIMITS.STAMINA_REGEN_MS));
}

// ─── DAILY WINDOW ────────────────────────────────────────────────────────────

/**
 * Resets daily counters if the rolling 24h window has expired.
 * Also resets the stamina tonic daily limit.
 */
function applyDailyReset(user) {
    const h = user.hunt;
    const now = Date.now();
    if (!h.dailyWindowStart || now - h.dailyWindowStart.getTime() >= LIMITS.DAILY_WINDOW_MS) {
        h.dailyCoins        = 0;
        h.dailyHunts        = 0;
        h.dailyWindowStart  = new Date(now);
        h.staminaTonicsToday = 0;
        h.lastTonicDayReset  = new Date(now);
        user.markModified('hunt');
    }
}

// ─── SUCCESS FORMULA ─────────────────────────────────────────────────────────

/**
 * Calculates the clamped hunt success chance (0.10 → 0.95).
 *
 * Components:
 *   base_weapon_rate     — from weapon tier
 *   level bonus          — +0.3% per hunter level
 *   zone modifier        — difficulty penalty
 *   consumable bonuses   — focus / charm
 *   durability penalty   — scales when durability < 30%
 *   upgrade bonus        — rifled barrel / scope
 *   pity bonus           — after consecutive failures
 */
function calculateSuccessChance(user, weapon, zone) {
    const h = user.hunt;
    const weaponData = WEAPON_BY_TIER[weapon.tier];

    let chance = weaponData.successRate;

    // Level bonus
    chance += (h.level - 1) * 0.003;

    // Zone difficulty
    chance += zone.difficultyMod;

    // Active charm
    if (h.activeCharm === 'luck_charm') chance += 0.03;

    // Hunter's focus
    if (h.activeFocus) chance += 0.10;

    // Upgrade: rifled barrel
    if (weapon.upgrade === 'rifled_barrel') {
        chance += WEAPON_UPGRADES.rifled_barrel.effect.successBonus;
    }

    // Durability penalty: ramps from 0 at 30% → −0.20 at 0% durability
    const durPct = weapon.currentDurability / weapon.maxDurability;
    if (durPct < 0.30) {
        chance -= (0.30 - durPct) * (0.20 / 0.30);
    }

    // Pity system: consecutive failure streak bonus
    const pityStacks = Math.min(h.consecutiveFails, LIMITS.PITY_CONSECUTIVE_FAILS);
    if (pityStacks > 0) {
        chance += pityStacks * LIMITS.PITY_BONUS_PER_STACK;
    }

    return Math.min(0.95, Math.max(0.10, chance));
}

// ─── CRIT CHANCE ─────────────────────────────────────────────────────────────

function calculateCritChance(user) {
    const h = user.hunt;
    let crit = 0.03;

    // Prestige bonus
    const p = Math.min(h.prestige, PRESTIGE_BONUSES.length - 1);
    crit += PRESTIGE_BONUSES[p].critBonus;

    // Luck charm
    if (h.activeCharm === 'luck_charm') crit += 0.05;

    // Permanent lucky paw upgrade
    if (h.luckyPaw) crit += 0.01;

    // Level bonus: 1% per 10 levels
    crit += Math.floor(h.level / 10) * 0.01;

    return Math.min(LIMITS.MAX_CRIT_CHANCE, crit);
}

// ─── RNG HELPERS ─────────────────────────────────────────────────────────────

function weightedRoll(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    for (const item of items) {
        r -= item.weight;
        if (r <= 0) return item;
    }
    return items[items.length - 1];
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── TIER ROLL ───────────────────────────────────────────────────────────────

/**
 * Rolls an animal tier from the zone's weighted table.
 * Bait consumables shift weight from common → rare/epic tiers.
 */
function rollTier(user, zone) {
    const h = user.hunt;
    const w = { ...zone.tierWeights };

    // Apply bait shift: take from common, add to rare+
    if (h.activeBait === 'basic_bait') {
        const shift = w.common * 0.08;
        w.common  = Math.max(0, w.common - shift);
        w.rare   += shift;
    } else if (h.activeBait === 'premium_bait') {
        const shiftRare = w.common * 0.15;
        const shiftEpic = w.common * 0.05;
        w.common  = Math.max(0, w.common - shiftRare - shiftEpic);
        w.rare   += shiftRare;
        w.epic   += shiftEpic;
    }

    // Apply weapon rarity boost: shift from common
    const weaponData = WEAPON_BY_TIER[user.hunt.weapons[user.hunt.equippedWeaponIndex]?.tier ?? 1];
    const rarityBoost = (weaponData?.rarityBoost ?? 0) + (
        user.hunt.weapons[user.hunt.equippedWeaponIndex]?.upgrade === 'scope'
            ? WEAPON_UPGRADES.scope.effect.rarityBonus : 0
    );
    if (rarityBoost > 0) {
        const shift = w.common * rarityBoost;
        w.common = Math.max(0, w.common - shift);
        w.rare  += shift * 0.6;
        w.epic  += shift * 0.3;
        w.legendary += shift * 0.1;
    }

    // Apply prestige rarity bonus
    const p = Math.min(h.prestige, PRESTIGE_BONUSES.length - 1);
    const presBoost = PRESTIGE_BONUSES[p].rarityBonus;
    if (presBoost > 0) {
        const shift = w.common * presBoost;
        w.common = Math.max(0, w.common - shift);
        w.rare  += shift;
    }

    const tiers = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];
    const items = tiers.map(t => ({ tier: t, weight: w[t] ?? 0 })).filter(i => i.weight > 0);
    return weightedRoll(items).tier;
}

// ─── ANIMAL ROLL ─────────────────────────────────────────────────────────────

/**
 * Picks a specific animal from the resolved tier that can spawn in this zone.
 */
function rollAnimal(tier, zoneId) {
    const pool = (ANIMALS_BY_TIER[tier] ?? []).filter(a =>
        a.zones.includes('all') || a.zones.includes(zoneId)
    );
    if (!pool.length) {
        // Fallback to any animal of this tier
        const fallback = ANIMALS_BY_TIER[tier];
        if (!fallback?.length) return ANIMALS_BY_TIER['common'][0];
        return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── FAILURE SEVERITY ────────────────────────────────────────────────────────

const FAILURE_SEVERITIES = [
    { id: 'clean_miss', label: 'Clean Miss',  durLoss: 1, injuryMs: 0,                        xp: 0, msg: 'The animal darted away before you could get a shot off.' },
    { id: 'clean_miss', label: 'Clean Miss',  durLoss: 1, injuryMs: 0,                        xp: 0, msg: 'Clean miss. Not even close.' },
    { id: 'spooked',    label: 'Spooked',     durLoss: 2, injuryMs: 0,                        xp: 5, msg: 'The animal heard you coming and bolted.' },
    { id: 'spooked',    label: 'Spooked',     durLoss: 2, injuryMs: 0,                        xp: 5, msg: 'You spooked your prey. Better luck next time.' },
    { id: 'jammed',     label: 'Jammed',      durLoss: 5, injuryMs: 0,                        xp: 0, msg: 'Your rifle jammed mid-shot! The animal escaped.' },
    { id: 'injured',    label: 'Injured',     durLoss: 3, injuryMs: LIMITS.INJURY_PENALTY_MS, xp: 0, msg: 'You tripped chasing the target and twisted your ankle.' }
];

function rollFailureSeverity() {
    return FAILURE_SEVERITIES[Math.floor(Math.random() * FAILURE_SEVERITIES.length)];
}

// ─── PAYOUT CALCULATION ───────────────────────────────────────────────────────

/**
 * Applies anti-exploit modifiers to a raw payout:
 *   - Prestige payout bonus
 *   - Zone payout bonus
 *   - Diminishing returns (daily hunt count)
 *   - Daily coin caps (soft and hard)
 * Returns { adjustedPayout, cappedByHard }
 */
function applyPayoutModifiers(user, rawPayout, zone) {
    const h = user.hunt;
    let payout = rawPayout;

    // Zone bonus (e.g. Legendary Peaks +20%)
    if (zone.payoutBonus > 0) payout *= (1 + zone.payoutBonus);

    // Prestige payout bonus
    const p = Math.min(h.prestige, PRESTIGE_BONUSES.length - 1);
    const presBonus = PRESTIGE_BONUSES[p].payoutBonus;
    if (presBonus > 0) payout *= (1 + presBonus);

    // Diminishing returns based on daily hunt count
    if (h.dailyHunts >= LIMITS.DIM_RETURNS_THRESHOLD_3) {
        payout *= 0.55;
    } else if (h.dailyHunts >= LIMITS.DIM_RETURNS_THRESHOLD_2) {
        payout *= 0.70;
    } else if (h.dailyHunts >= LIMITS.DIM_RETURNS_THRESHOLD_1) {
        payout *= 0.85;
    }

    payout = Math.round(payout);

    // Hard cap: zero coins
    if (h.dailyCoins >= LIMITS.DAILY_HARD_CAP) {
        return { adjustedPayout: 0, cappedByHard: true };
    }

    // Soft cap: 50% reduction
    if (h.dailyCoins >= LIMITS.DAILY_SOFT_CAP) {
        payout = Math.round(payout * 0.50);
    }

    // Don't let payout push past hard cap
    const remaining = LIMITS.DAILY_HARD_CAP - h.dailyCoins;
    payout = Math.min(payout, remaining);

    return { adjustedPayout: Math.max(0, payout), cappedByHard: false };
}

// ─── DURABILITY ───────────────────────────────────────────────────────────────

/**
 * Deducts durability from a weapon after a hunt.
 * Reinforced stock upgrade reduces loss by 1 (min 1).
 */
function applyDurabilityLoss(weapon, baseLoss) {
    let loss = baseLoss;
    if (weapon.upgrade === 'reinforced_stock') {
        loss = Math.max(1, loss - WEAPON_UPGRADES.reinforced_stock.effect.durabilityReduction);
    }
    weapon.currentDurability = Math.max(0, weapon.currentDurability - loss);
    updateWeaponStatus(weapon);
}

/**
 * Updates weapon status label based on current/max durability ratios.
 */
function updateWeaponStatus(weapon) {
    if (weapon.currentDurability <= 0) {
        weapon.status = 'broken';
        return;
    }
    const ratio = weapon.maxDurability / weapon.baseDurability;
    if (ratio < 0.20)       weapon.status = 'condemned';
    else if (ratio < 0.50)  weapon.status = 'degraded';
    else                    weapon.status = 'good';
}

/**
 * Applies one repair cycle to a weapon:
 *   - Restores up to `amount` durability (capped at maxDurability)
 *   - Permanently degrades maxDurability by 10% of baseDurability
 *
 * Returns { cost, restoredAmount, newStatus, condemned }
 */
function applyRepair(weapon, requestedAmount) {
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    if (!weaponData) throw new Error('Unknown weapon tier');

    if (weapon.status === 'condemned') {
        return { error: 'This weapon is condemned and cannot be repaired. Replace it.' };
    }
    if (weapon.status !== 'broken' && weapon.currentDurability >= weapon.maxDurability) {
        return { error: 'Weapon is already at full durability.' };
    }

    const needed = weapon.maxDurability - weapon.currentDurability;
    const amount = Math.min(requestedAmount ?? needed, needed);
    const units  = Math.ceil(amount / 20);
    const cost   = units * weaponData.repairCostPer20;

    // Restore durability
    weapon.currentDurability = Math.min(weapon.maxDurability, weapon.currentDurability + amount);

    // Degrade max durability by 10% of base per repair cycle
    const degradation = Math.floor(weapon.baseDurability * 0.10);
    weapon.maxDurability  = Math.max(Math.floor(weapon.baseDurability * 0.10), weapon.maxDurability - degradation);
    weapon.repairCount   += 1;

    // Cap current to new max
    weapon.currentDurability = Math.min(weapon.currentDurability, weapon.maxDurability);

    updateWeaponStatus(weapon);

    return { cost, restoredAmount: amount, newStatus: weapon.status, condemned: weapon.status === 'condemned' };
}

// ─── LEVEL / XP ──────────────────────────────────────────────────────────────

/**
 * Calculates hunter level from total XP.
 * Returns the highest level whose xpRequired <= totalXp.
 */
function levelFromXp(totalXp) {
    let level = 1;
    for (const row of HUNTER_LEVELS) {
        if (totalXp >= row.xpRequired) level = row.level;
        else break;
    }
    return level;
}

/**
 * Returns the HUNTER_LEVELS row for the given level (1-indexed).
 */
function getLevelData(level) {
    return HUNTER_LEVELS[Math.min(level, HUNTER_LEVELS.length) - 1];
}

/**
 * Returns XP needed to reach next level, or null if max level.
 */
function xpToNextLevel(currentLevel, currentXp) {
    if (currentLevel >= HUNTER_LEVELS.length) return null;
    return HUNTER_LEVELS[currentLevel].xpRequired - currentXp;
}

/**
 * Adds XP, handles level-up, returns { oldLevel, newLevel, leveledUp }.
 */
function applyXp(user, xpGain) {
    const h = user.hunt;
    const oldLevel = h.level;
    h.xp += xpGain;
    const newLevel = levelFromXp(h.xp);

    if (newLevel > oldLevel) {
        h.level = newLevel;
        user.markModified('hunt');
        return { oldLevel, newLevel, leveledUp: true };
    }
    return { oldLevel, newLevel: oldLevel, leveledUp: false };
}

// ─── CONSUMABLE MANAGEMENT ───────────────────────────────────────────────────

/**
 * Activates a consumable from the player's stock.
 * Returns { success, error }
 */
function activateConsumable(user, consumableId) {
    const h = user.hunt;
    const { CONSUMABLES } = require('../data/huntData');
    const def = CONSUMABLES[consumableId];
    if (!def) return { success: false, error: 'Unknown consumable.' };

    const stock = h.consumables[consumableId] ?? 0;
    if (stock <= 0) return { success: false, error: `You don't have any **${def.name}**.` };

    if (def.type === 'bait') {
        if (h.activeBait) return { success: false, error: `You already have **${h.activeBait}** active. Wait for it to expire.` };
        h.consumables[consumableId] -= 1;
        h.activeBait          = consumableId;
        h.activeBaitHuntsLeft = def.huntsLeft;
    } else if (def.type === 'charm') {
        if (h.activeCharm) return { success: false, error: `You already have **${h.activeCharm}** active. Wait for it to expire.` };
        h.consumables[consumableId] -= 1;
        h.activeCharm          = consumableId;
        h.activeCharmHuntsLeft = def.huntsLeft;
    } else if (def.type === 'instant' && consumableId === 'hunters_focus') {
        if (h.activeFocus) return { success: false, error: `Hunter's Focus is already queued for your next hunt.` };
        h.consumables[consumableId] -= 1;
        h.activeFocus = true;
    } else if (def.type === 'instant' && consumableId === 'xp_scroll') {
        if (h.activeXpScroll) return { success: false, error: `An XP Scroll is already queued for your next hunt.` };
        h.consumables[consumableId] -= 1;
        h.activeXpScroll = true;
    } else if (def.type === 'stamina') {
        // Reset tonic day if needed
        const now = Date.now();
        const tonicWindowOk = h.lastTonicDayReset && (now - h.lastTonicDayReset.getTime() < LIMITS.DAILY_WINDOW_MS);
        if (!tonicWindowOk) {
            h.staminaTonicsToday = 0;
            h.lastTonicDayReset  = new Date(now);
        }
        if (h.staminaTonicsToday >= LIMITS.STAMINA_TONICS_PER_DAY) {
            return { success: false, error: `You've already used ${LIMITS.STAMINA_TONICS_PER_DAY} Stamina Tonics today.` };
        }
        const max = getMaxStamina(user);
        if (h.stamina >= max) return { success: false, error: `Your stamina is already full.` };
        h.consumables[consumableId] -= 1;
        h.stamina = Math.min(max, h.stamina + def.staminaRestore);
        h.staminaTonicsToday += 1;
    } else if (def.type === 'repair') {
        // Repair kit used from huntshop use — handled in repair command
        return { success: false, error: `Use repair kits with \`/huntrepair\`.` };
    } else {
        return { success: false, error: 'That item cannot be activated this way.' };
    }

    user.markModified('hunt');
    return { success: true };
}

/**
 * Ticks down active consumables after a hunt, clearing expired ones.
 */
function tickConsumables(user) {
    const h = user.hunt;
    if (h.activeBait) {
        h.activeBaitHuntsLeft -= 1;
        if (h.activeBaitHuntsLeft <= 0) {
            h.activeBait          = null;
            h.activeBaitHuntsLeft = 0;
        }
    }
    if (h.activeCharm) {
        h.activeCharmHuntsLeft -= 1;
        if (h.activeCharmHuntsLeft <= 0) {
            h.activeCharm          = null;
            h.activeCharmHuntsLeft = 0;
        }
    }
    h.activeFocus    = false;
    h.activeXpScroll = false;
    user.markModified('hunt');
}

// ─── FULL HUNT EXECUTION ─────────────────────────────────────────────────────

/**
 * Runs a complete hunt for the given user.
 * Mutates user in place; caller must call user.save() afterward.
 *
 * Returns a HuntResult object:
 * {
 *   success: boolean,
 *   animal?: Animal,
 *   tier?: string,
 *   rawPayout?: number,
 *   finalPayout?: number,
 *   isCrit?: boolean,
 *   critMultiplier?: number,
 *   specialDrop?: { itemId, name } | null,
 *   xpEarned: number,
 *   levelUp?: { oldLevel, newLevel },
 *   failure?: { severity, message },
 *   durabilityLost: number,
 *   weaponBroke: boolean,
 *   cappedByHard?: boolean,
 *   expiredBait?: string,
 *   expiredCharm?: string,
 *   activeBaitAfter?: string,
 *   activeCharmAfter?: string
 * }
 */
function executeHunt(user, zoneId) {
    const h      = user.hunt;
    const zone   = ZONES[zoneId ?? h.activeZone];
    const weapon = h.weapons[h.equippedWeaponIndex];

    if (!zone || !weapon) {
        return {
            success: false, xpEarned: 0, durabilityLost: 0, weaponBroke: false,
            failure: { severity: { id: 'error', durLoss: 0, injuryMs: 0, xp: 0 }, message: 'Invalid hunt state.' }
        };
    }

    const successChance = calculateSuccessChance(user, weapon, zone);
    const success = Math.random() < successChance;

    // Track which consumables were active BEFORE ticking
    const baitBefore  = h.activeBait;
    const charmBefore = h.activeCharm;

    const result = {
        success,
        xpEarned: 0,
        durabilityLost: 0,
        weaponBroke: false
    };

    if (success) {
        // ── Resolve animal ──────────────────────────────────────────────
        const tier   = rollTier(user, zone);
        const animal = rollAnimal(tier, zoneId ?? h.activeZone);
        const rawPayout = randInt(animal.payoutMin, animal.payoutMax);

        // Crit
        const critChance     = calculateCritChance(user);
        const isCrit         = Math.random() < critChance;
        const critMultiplier = isCrit ? (1.5 + Math.random() * 1.0) : 1.0;

        const payoutBeforeMods = Math.round(rawPayout * critMultiplier);
        const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, payoutBeforeMods, zone);

        // Special drop
        let specialDrop = null;
        if (animal.specialDrop && Math.random() < (isCrit ? animal.specialDrop.chance * 2 : animal.specialDrop.chance)) {
            specialDrop = animal.specialDrop;
            const matKey = animal.specialDrop.itemId;
            if (h.materials[matKey] != null) {
                h.materials[matKey] += 1;
            }
        }

        // XP
        let xpGain = animal.xp;
        if (isCrit) xpGain = Math.round(xpGain * 1.5);
        if (h.activeXpScroll) xpGain = Math.round(xpGain * 1.5);

        // Durability (-1 on success)
        applyDurabilityLoss(weapon, 1);
        result.durabilityLost = 1;

        // Apply payout
        user.balance         += adjustedPayout;
        h.totalEarned        += adjustedPayout;
        h.dailyCoins         += adjustedPayout;
        if (adjustedPayout > h.bestPayout) h.bestPayout = adjustedPayout;

        // Statistics
        h.successfulHunts    += 1;
        h.consecutiveFails    = 0;
        if (tier === 'legendary') h.legendaryKills += 1;
        if (tier === 'event')     h.eventKills     += 1;

        // XP & level
        const lvResult = applyXp(user, xpGain);

        Object.assign(result, {
            animal, tier, rawPayout, finalPayout: adjustedPayout,
            isCrit, critMultiplier: parseFloat(critMultiplier.toFixed(2)),
            specialDrop, xpEarned: xpGain,
            levelUp: lvResult.leveledUp ? lvResult : null,
            cappedByHard
        });

        if (weapon.currentDurability <= 0) result.weaponBroke = true;

    } else {
        // ── Failure path ────────────────────────────────────────────────
        const severity = rollFailureSeverity();
        applyDurabilityLoss(weapon, severity.durLoss);
        result.durabilityLost = severity.durLoss;

        if (severity.injuryMs > 0) {
            h.injuryUntil = new Date(Date.now() + severity.injuryMs);
        }

        h.consecutiveFails += 1;

        let xpGain = severity.xp;
        if (h.activeXpScroll && xpGain > 0) xpGain = Math.round(xpGain * 1.5);
        if (xpGain > 0) applyXp(user, xpGain);

        result.xpEarned   = xpGain;
        result.failure    = { severity, message: severity.msg };

        if (weapon.currentDurability <= 0) result.weaponBroke = true;
    }

    // ── Common post-hunt updates ────────────────────────────────────────
    h.totalHunts  += 1;
    h.dailyHunts  += 1;
    h.stamina     -= 1;
    h.lastHunt     = new Date();

    // Ammo deduction (handled by caller after pre-check)

    // Tick consumables; record expiry for result embed
    tickConsumables(user);
    result.expiredBait      = baitBefore  && !h.activeBait  ? baitBefore  : null;
    result.expiredCharm     = charmBefore && !h.activeCharm ? charmBefore : null;
    result.activeBaitAfter  = h.activeBait;
    result.activeCharmAfter = h.activeCharm;

    user.markModified('hunt');

    return result;
}

// ─── HUNT DAILY QUESTS ───────────────────────────────────────────────────────

/**
 * Assigns up to DAILY_QUEST_COUNT hunt quests if the player currently has none.
 * Eligible templates are filtered by hunter level and unlocked zones.
 * Called at the start of each hunt command execution.
 */
function assignDailyHuntQuests(user) {
    const h = user.hunt;
    const now = Date.now();

    // Expire old hunt quests
    user.quests = user.quests.filter(q =>
        !q.questId.startsWith('hq_') ||
        (q.expiresAt && q.expiresAt.getTime() > now)
    );

    // Count active (non-expired) hunt quests — claimed ones have progress === -1
    const activeCount = user.quests.filter(q => q.questId.startsWith('hq_')).length;

    // Only assign a fresh batch when the player has no hunt quests at all
    if (activeCount > 0) return;

    const eligible = HUNT_QUEST_TEMPLATES.filter(t =>
        h.level >= t.minLevel &&
        (t.type !== 'zone_hunts' || h.unlockedZones.includes(t.zone))
    );

    // Shuffle and take up to DAILY_QUEST_COUNT
    const shuffled  = eligible.slice().sort(() => Math.random() - 0.5);
    const toAssign  = shuffled.slice(0, DAILY_QUEST_COUNT);
    const expiresAt = new Date(now + LIMITS.DAILY_WINDOW_MS);

    for (const template of toAssign) {
        user.quests.push({ questId: template.id, progress: 0, completedAt: null, expiresAt });
    }

    if (toAssign.length) user.markModified('quests');
}

/**
 * Updates progress for all active hunt quests based on the hunt result.
 * Must be called after executeHunt, before user.save().
 */
function updateHuntQuestProgress(user, result, zoneId) {
    const now = Date.now();
    const huntQuests = user.quests.filter(q =>
        q.questId.startsWith('hq_') &&
        !q.completedAt &&
        q.progress !== -1 &&
        q.expiresAt?.getTime() > now
    );

    if (!huntQuests.length) return;

    for (const quest of huntQuests) {
        const template = HUNT_QUEST_TEMPLATES.find(t => t.id === quest.questId);
        if (!template) continue;

        switch (template.type) {
            case 'total_hunts':
                quest.progress += 1;
                break;
            case 'rare_plus_kills':
                if (result.success && ['rare', 'epic', 'legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'epic_plus_kills':
                if (result.success && ['epic', 'legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'legendary_plus_kills':
                if (result.success && ['legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'crits':
                if (result.success && result.isCrit) quest.progress += 1;
                break;
            case 'earn_coins':
                if (result.success && result.finalPayout > 0)
                    quest.progress = Math.min(quest.progress + result.finalPayout, template.target);
                break;
            case 'material_drops':
                if (result.success && result.specialDrop) quest.progress += 1;
                break;
            case 'success_streak':
                if (result.success) quest.progress += 1;
                else               quest.progress  = 0;
                break;
            case 'zone_hunts':
                if (zoneId === template.zone) quest.progress += 1;
                break;
        }

        if (quest.progress >= template.target && !quest.completedAt) {
            quest.completedAt = new Date(now);
        }
    }

    user.markModified('quests');
}

// ─── FORMATTING HELPERS ───────────────────────────────────────────────────────

function formatMs(ms) {
    if (ms <= 0) return '0s';
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const hrs  = Math.floor(mins / 60);
    if (hrs  > 0) return `${hrs}h ${mins % 60}m`;
    if (mins > 0) return `${mins}m ${secs % 60}s`;
    return `${secs}s`;
}

function weaponStatusEmoji(status) {
    return { good: '✅', degraded: '⚠️', condemned: '💀', broken: '❌' }[status] ?? '❓';
}

function durabilityBar(current, max, length = 10) {
    const filled = Math.round((current / max) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}

module.exports = {
    ensureHuntData,
    getMaxStamina,
    applyStaminaRegen,
    msUntilNextStamina,
    applyDailyReset,
    calculateSuccessChance,
    calculateCritChance,
    rollTier,
    rollAnimal,
    rollFailureSeverity,
    applyPayoutModifiers,
    applyDurabilityLoss,
    updateWeaponStatus,
    applyRepair,
    levelFromXp,
    getLevelData,
    xpToNextLevel,
    applyXp,
    activateConsumable,
    tickConsumables,
    executeHunt,
    assignDailyHuntQuests,
    updateHuntQuestProgress,
    formatMs,
    weaponStatusEmoji,
    durabilityBar
};
