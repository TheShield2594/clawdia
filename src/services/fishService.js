'use strict';

const {
    ROD_TIERS,
    ROD_BY_TIER,
    ROD_UPGRADES,
    LOCATIONS,
    FISH,
    FISH_BY_TIER,
    JUNK_ITEMS,
    TREASURE_ITEMS,
    FISHER_LEVELS,
    LIMITS,
    PRESTIGE_BONUSES,
    FAILURE_SEVERITIES,
    FISH_QUEST_TEMPLATES
} = require('../data/fishData');

const DAILY_QUEST_COUNT = 3;

// ─── INIT ────────────────────────────────────────────────────────────────────

function ensureFishingData(user) {
    if (!user.fishing) user.fishing = {};
    const f = user.fishing;

    if (f.stamina            == null) f.stamina            = 10;
    if (f.staminaLastRegen   == null) f.staminaLastRegen   = null;
    if (f.energyDrinksToday  == null) f.energyDrinksToday  = 0;
    if (f.lastDrinkDayReset  == null) f.lastDrinkDayReset  = null;
    if (f.xp                 == null) f.xp                 = 0;
    if (f.level              == null) f.level               = 1;
    if (f.prestige           == null) f.prestige            = 0;
    if (f.lastCast           == null) f.lastCast            = null;
    if (f.injuryUntil        == null) f.injuryUntil         = null;
    if (f.activeLocation     == null) f.activeLocation      = 'pond';
    if (!Array.isArray(f.unlockedLocations)) f.unlockedLocations = ['pond'];
    if (f.equippedRodIndex   == null) f.equippedRodIndex    = -1;
    if (!Array.isArray(f.rods))       f.rods                = [];
    if (!f.bait)         f.bait         = {};
    if (!f.consumables)  f.consumables  = {};
    if (!f.materials)    f.materials    = {};
    if (f.activeBait           == null) f.activeBait           = null;
    if (f.activeBaitCastsLeft  == null) f.activeBaitCastsLeft  = 0;
    if (f.activeLuck           == null) f.activeLuck           = false;
    if (f.activeXpScroll       == null) f.activeXpScroll       = false;
    if (f.luckyHook            == null) f.luckyHook            = false;
    if (f.totalCasts           == null) f.totalCasts           = 0;
    if (f.successfulCasts      == null) f.successfulCasts      = 0;
    if (f.totalEarned          == null) f.totalEarned          = 0;
    if (f.legendaryCatches     == null) f.legendaryCatches     = 0;
    if (f.eventCatches         == null) f.eventCatches         = 0;
    if (f.bestPayout           == null) f.bestPayout           = 0;
    if (f.consecutiveFails     == null) f.consecutiveFails     = 0;
    if (f.dailyCoins           == null) f.dailyCoins           = 0;
    if (f.dailyCasts           == null) f.dailyCasts           = 0;
    if (f.dailyWindowStart     == null) f.dailyWindowStart     = null;

    if (!f.unlockedLocations.includes('pond')) f.unlockedLocations.push('pond');

    user.markModified('fishing');
}

// ─── STAMINA ─────────────────────────────────────────────────────────────────

function getMaxStamina(user) {
    const prestige = user.fishing?.prestige ?? 0;
    const bonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)]?.staminaBonus ?? 0;
    return LIMITS.MAX_STAMINA_BASE + bonus;
}

function applyStaminaRegen(user) {
    const f = user.fishing;
    const max = getMaxStamina(user);
    if (f.stamina >= max) {
        f.stamina = max;
        f.staminaLastRegen = new Date();
        user.markModified('fishing');
        return;
    }
    if (!f.staminaLastRegen) {
        f.staminaLastRegen = new Date();
        user.markModified('fishing');
        return;
    }
    const elapsed   = Date.now() - f.staminaLastRegen.getTime();
    const intervals = Math.floor(elapsed / LIMITS.STAMINA_REGEN_MS);
    if (intervals <= 0) return;

    f.stamina = Math.min(max, f.stamina + intervals);
    f.staminaLastRegen = new Date(f.staminaLastRegen.getTime() + intervals * LIMITS.STAMINA_REGEN_MS);
    user.markModified('fishing');
}

function msUntilNextStamina(user) {
    const f = user.fishing;
    const max = getMaxStamina(user);
    if (f.stamina >= max) return 0;
    if (!f.staminaLastRegen) return LIMITS.STAMINA_REGEN_MS;
    const elapsed = Date.now() - f.staminaLastRegen.getTime();
    return Math.max(0, LIMITS.STAMINA_REGEN_MS - (elapsed % LIMITS.STAMINA_REGEN_MS));
}

// ─── DAILY WINDOW ─────────────────────────────────────────────────────────────

function applyDailyReset(user) {
    const f   = user.fishing;
    const now = Date.now();
    if (!f.dailyWindowStart || now - f.dailyWindowStart.getTime() >= LIMITS.DAILY_WINDOW_MS) {
        f.dailyCoins        = 0;
        f.dailyCasts        = 0;
        f.dailyWindowStart  = new Date(now);
        f.energyDrinksToday = 0;
        f.lastDrinkDayReset = new Date(now);
        user.markModified('fishing');
    }
}

// ─── SUCCESS FORMULA ──────────────────────────────────────────────────────────

function calculateSuccessChance(user, rod, location) {
    const f       = user.fishing;
    const rodData = ROD_BY_TIER[rod.tier];

    let chance = rodData.successRate;

    // Level bonus: +0.3% per fisher level
    chance += (f.level - 1) * 0.003;

    // Location difficulty
    chance += location.difficultyMod;

    // Angler's luck consumable
    if (f.activeLuck) chance += 0.10;

    // Upgrade: enhanced line
    if (rod.upgrade === 'enhanced_line') {
        chance += ROD_UPGRADES.enhanced_line.effect.successBonus;
    }

    // Durability penalty: ramps from 0 at 30% → −0.20 at 0%
    const durPct = rod.currentDurability / rod.maxDurability;
    if (durPct < 0.30) {
        chance -= (0.30 - durPct) * (0.20 / 0.30);
    }

    // Pity: consecutive fail streak
    const pityStacks = Math.min(f.consecutiveFails, LIMITS.PITY_CONSECUTIVE_FAILS);
    if (pityStacks > 0) chance += pityStacks * LIMITS.PITY_BONUS_PER_STACK;

    return Math.min(0.95, Math.max(0.10, chance));
}

// ─── CRIT CHANCE ─────────────────────────────────────────────────────────────

function calculateCritChance(user) {
    const f = user.fishing;
    let crit = 0.03;

    const p = Math.min(f.prestige, PRESTIGE_BONUSES.length - 1);
    crit += PRESTIGE_BONUSES[p].critBonus;

    if (f.luckyHook) crit += 0.01;

    // Level bonus: 1% per 10 levels
    crit += Math.floor(f.level / 10) * 0.01;

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

// ─── CATCH TYPE ROLL ─────────────────────────────────────────────────────────

/**
 * Decides whether a successful cast yields a fish, junk, or treasure.
 */
function rollCatchType(location) {
    const r = Math.random();
    if (r < location.junkChance)                           return 'junk';
    if (r < location.junkChance + location.treasureChance) return 'treasure';
    return 'fish';
}

// ─── TIER ROLL ───────────────────────────────────────────────────────────────

function rollTier(user, location, rod) {
    const f = user.fishing;
    const w = { ...location.tierWeights };

    // Chum bait tier shift
    if (f.activeBait === 'chum_bait') {
        const shift = w.common * 0.08;
        w.common = Math.max(0, w.common - shift);
        w.rare  += shift;
    } else if (f.activeBait === 'premium_chum') {
        const shiftRare = w.common * 0.15;
        const shiftEpic = w.common * 0.05;
        w.common = Math.max(0, w.common - shiftRare - shiftEpic);
        w.rare  += shiftRare;
        w.epic  += shiftEpic;
    }

    // Rod rarity boost
    const rodData = ROD_BY_TIER[rod.tier];
    const rarityBoost = (rodData?.rarityBoost ?? 0) +
        (rod.upgrade === 'polarized_lens' ? ROD_UPGRADES.polarized_lens.effect.rarityBonus : 0);
    if (rarityBoost > 0) {
        const shift = w.common * rarityBoost;
        w.common     = Math.max(0, w.common - shift);
        w.rare      += shift * 0.6;
        w.epic      += shift * 0.3;
        w.legendary += shift * 0.1;
    }

    // Prestige rarity bonus
    const p = Math.min(f.prestige, PRESTIGE_BONUSES.length - 1);
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

// ─── FISH ROLL ───────────────────────────────────────────────────────────────

function rollFish(tier, locationId) {
    const pool = (FISH_BY_TIER[tier] ?? []).filter(fish =>
        fish.locations.includes('all') || fish.locations.includes(locationId)
    );
    if (!pool.length) {
        const fallback = FISH_BY_TIER[tier];
        if (!fallback?.length) return FISH_BY_TIER['common'][0];
        return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── FAILURE ROLL ─────────────────────────────────────────────────────────────

function rollFailureSeverity() {
    return FAILURE_SEVERITIES[Math.floor(Math.random() * FAILURE_SEVERITIES.length)];
}

// ─── PAYOUT MODIFIERS ─────────────────────────────────────────────────────────

function applyPayoutModifiers(user, rawPayout, location) {
    const f = user.fishing;
    let payout = rawPayout;

    if (location.payoutBonus > 0) payout *= (1 + location.payoutBonus);

    const p = Math.min(f.prestige, PRESTIGE_BONUSES.length - 1);
    const presBonus = PRESTIGE_BONUSES[p].payoutBonus;
    if (presBonus > 0) payout *= (1 + presBonus);

    if (f.dailyCasts >= LIMITS.DIM_RETURNS_THRESHOLD_3) {
        payout *= 0.55;
    } else if (f.dailyCasts >= LIMITS.DIM_RETURNS_THRESHOLD_2) {
        payout *= 0.70;
    } else if (f.dailyCasts >= LIMITS.DIM_RETURNS_THRESHOLD_1) {
        payout *= 0.85;
    }

    payout = Math.round(payout);

    if (f.dailyCoins >= LIMITS.DAILY_HARD_CAP) {
        return { adjustedPayout: 0, cappedByHard: true };
    }
    if (f.dailyCoins >= LIMITS.DAILY_SOFT_CAP) {
        payout = Math.round(payout * 0.50);
    }

    const remaining = LIMITS.DAILY_HARD_CAP - f.dailyCoins;
    payout = Math.min(payout, remaining);

    return { adjustedPayout: Math.max(0, payout), cappedByHard: false };
}

// ─── DURABILITY ───────────────────────────────────────────────────────────────

function applyDurabilityLoss(rod, baseLoss) {
    let loss = baseLoss;
    if (rod.upgrade === 'reinforced_grip') {
        loss = Math.max(1, loss - ROD_UPGRADES.reinforced_grip.effect.durabilityReduction);
    }
    rod.currentDurability = Math.max(0, rod.currentDurability - loss);
    updateRodStatus(rod);
}

function updateRodStatus(rod) {
    if (rod.currentDurability <= 0) { rod.status = 'broken'; return; }
    const ratio = rod.currentDurability / rod.maxDurability;
    if (ratio < 0.20)      rod.status = 'condemned';
    else if (ratio < 0.50) rod.status = 'degraded';
    else                   rod.status = 'good';
}

function applyRepair(rod, requestedAmount) {
    const rodData = ROD_BY_TIER[rod.tier];
    if (!rodData) throw new Error('Unknown rod tier');

    if (rod.status === 'condemned') {
        return { error: 'This rod is condemned and cannot be repaired. Replace it.' };
    }
    // Compute post-degradation max FIRST so cost and restoredAmount are accurate
    const degradation = Math.floor(rod.baseDurability * 0.10);
    const newMax      = Math.max(Math.floor(rod.baseDurability * 0.10), rod.maxDurability - degradation);

    if (rod.status !== 'broken' && rod.currentDurability >= newMax) {
        return { error: 'Rod is already at full durability.' };
    }

    const needed = Math.max(0, newMax - rod.currentDurability);
    const amount = Math.min(requestedAmount ?? needed, needed);
    const units  = Math.ceil(amount / 20);
    const cost   = units * rodData.repairCostPer20;

    rod.maxDurability     = newMax;
    rod.currentDurability = Math.min(newMax, rod.currentDurability + amount);
    rod.repairCount      += 1;

    updateRodStatus(rod);

    return { cost, restoredAmount: amount, newStatus: rod.status, condemned: rod.status === 'condemned' };
}

// ─── LEVEL / XP ──────────────────────────────────────────────────────────────

function levelFromXp(totalXp) {
    let level = 1;
    for (const row of FISHER_LEVELS) {
        if (totalXp >= row.xpRequired) level = row.level;
        else break;
    }
    return level;
}

function getLevelData(level) {
    return FISHER_LEVELS[Math.min(level, FISHER_LEVELS.length) - 1];
}

function xpToNextLevel(currentLevel, currentXp) {
    if (currentLevel >= FISHER_LEVELS.length) return null;
    return FISHER_LEVELS[currentLevel].xpRequired - currentXp;
}

function applyXp(user, xpGain) {
    const f        = user.fishing;
    const oldLevel = f.level;
    f.xp          += xpGain;
    const newLevel = levelFromXp(f.xp);

    if (newLevel > oldLevel) {
        f.level = newLevel;
        user.markModified('fishing');
        return { oldLevel, newLevel, leveledUp: true };
    }
    return { oldLevel, newLevel: oldLevel, leveledUp: false };
}

// ─── CONSUMABLE MANAGEMENT ───────────────────────────────────────────────────

function activateConsumable(user, consumableId) {
    const f = user.fishing;
    const { CONSUMABLES } = require('../data/fishData');
    const def = CONSUMABLES[consumableId];
    if (!def) return { success: false, error: 'Unknown consumable.' };

    const stock = f.consumables[consumableId] ?? 0;
    if (stock <= 0) return { success: false, error: `You don't have any **${def.name}**.` };

    if (def.type === 'bait') {
        if (f.activeBait) return { success: false, error: `You already have **${f.activeBait.replace(/_/g, ' ')}** active.` };
        f.consumables[consumableId] -= 1;
        f.activeBait          = consumableId;
        f.activeBaitCastsLeft = def.castsLeft;
    } else if (def.type === 'instant' && consumableId === 'anglers_luck') {
        if (f.activeLuck) return { success: false, error: `Angler's Luck is already queued.` };
        f.consumables[consumableId] -= 1;
        f.activeLuck = true;
    } else if (def.type === 'instant' && consumableId === 'fish_xp_scroll') {
        if (f.activeXpScroll) return { success: false, error: `An XP Scroll is already queued.` };
        f.consumables[consumableId] -= 1;
        f.activeXpScroll = true;
    } else if (def.type === 'stamina') {
        // Apply passive regen first so the "already full" check reflects real current stamina
        applyStaminaRegen(user);
        const now = Date.now();
        const drinkWindowOk = f.lastDrinkDayReset && (now - f.lastDrinkDayReset.getTime() < LIMITS.DAILY_WINDOW_MS);
        if (!drinkWindowOk) {
            f.energyDrinksToday = 0;
            f.lastDrinkDayReset = new Date(now);
        }
        if (f.energyDrinksToday >= LIMITS.ENERGY_DRINKS_PER_DAY) {
            return { success: false, error: `You've already used ${LIMITS.ENERGY_DRINKS_PER_DAY} Energy Drinks today.` };
        }
        const max = getMaxStamina(user);
        if (f.stamina >= max) return { success: false, error: `Your stamina is already full.` };
        f.consumables[consumableId] -= 1;
        f.stamina = Math.min(max, f.stamina + def.staminaRestore);
        f.energyDrinksToday += 1;
    } else if (def.type === 'repair') {
        return { success: false, error: `Use repair kits with \`/fishrepair\`.` };
    } else {
        return { success: false, error: 'That item cannot be activated this way.' };
    }

    user.markModified('fishing');
    return { success: true };
}

function tickConsumables(user) {
    const f = user.fishing;
    if (f.activeBait) {
        f.activeBaitCastsLeft -= 1;
        if (f.activeBaitCastsLeft <= 0) {
            f.activeBait          = null;
            f.activeBaitCastsLeft = 0;
        }
    }
    f.activeLuck     = false;
    f.activeXpScroll = false;
    user.markModified('fishing');
}

// ─── FULL CAST EXECUTION ──────────────────────────────────────────────────────

/**
 * Executes a complete fishing cast for the given user.
 * Mutates user in place; caller must call user.save() afterward.
 *
 * Returns a CastResult object:
 * {
 *   success: boolean,
 *   catchType?: 'fish' | 'junk' | 'treasure',
 *   fish?: Fish,
 *   junkItem?: JunkItem,
 *   treasureItem?: TreasureItem,
 *   tier?: string,
 *   rawPayout?: number,
 *   finalPayout?: number,
 *   isCrit?: boolean,
 *   critMultiplier?: number,
 *   sizeLabel?: string,
 *   specialDrop?: { itemId, name } | null,
 *   xpEarned: number,
 *   levelUp?: { oldLevel, newLevel } | null,
 *   failure?: { severity, message },
 *   durabilityLost: number,
 *   rodBroke: boolean,
 *   cappedByHard?: boolean,
 *   expiredBait?: string | null,
 *   activeBaitAfter?: string | null
 * }
 */
function executeCast(user, locationId) {
    const f        = user.fishing;
    const location = LOCATIONS[locationId ?? f.activeLocation];
    const rod      = f.rods[f.equippedRodIndex];

    if (!location || !rod) {
        return {
            success: false, xpEarned: 0, durabilityLost: 0, rodBroke: false,
            failure: { severity: { id: 'error', durLoss: 0, injuryMs: 0, xp: 0 }, message: 'Invalid fishing state.' }
        };
    }

    const successChance = calculateSuccessChance(user, rod, location);
    const success       = Math.random() < successChance;
    const baitBefore    = f.activeBait;

    const result = { success, xpEarned: 0, durabilityLost: 0, rodBroke: false };

    if (success) {
        const catchType = rollCatchType(location);
        result.catchType = catchType;

        if (catchType === 'junk') {
            const junk         = weightedRoll(JUNK_ITEMS);
            const payout       = randInt(junk.payoutMin, junk.payoutMax);
            const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, payout, location);

            applyDurabilityLoss(rod, 1);
            result.durabilityLost = 1;

            user.balance   += adjustedPayout;
            f.totalEarned  += adjustedPayout;
            f.dailyCoins   += adjustedPayout;

            let xpGain = 2;
            if (f.activeXpScroll) xpGain = Math.round(xpGain * 1.5);
            const lvResult = applyXp(user, xpGain);

            Object.assign(result, {
                junkItem: junk, finalPayout: adjustedPayout,
                xpEarned: xpGain, levelUp: lvResult.leveledUp ? lvResult : null, cappedByHard
            });
            f.successfulCasts += 1;
            f.consecutiveFails = 0;

        } else if (catchType === 'treasure') {
            const treasure     = weightedRoll(TREASURE_ITEMS);
            const payout       = randInt(treasure.payoutMin, treasure.payoutMax);
            const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, payout, location);

            applyDurabilityLoss(rod, 1);
            result.durabilityLost = 1;

            user.balance   += adjustedPayout;
            f.totalEarned  += adjustedPayout;
            f.dailyCoins   += adjustedPayout;
            if (adjustedPayout > f.bestPayout) f.bestPayout = adjustedPayout;

            let xpGain = 15;
            if (f.activeXpScroll) xpGain = Math.round(xpGain * 1.5);
            const lvResult = applyXp(user, xpGain);

            Object.assign(result, {
                treasureItem: treasure, finalPayout: adjustedPayout,
                xpEarned: xpGain, levelUp: lvResult.leveledUp ? lvResult : null, cappedByHard
            });
            f.successfulCasts += 1;
            f.consecutiveFails = 0;

        } else {
            // Fish catch
            const tier         = rollTier(user, location, rod);
            const fish         = rollFish(tier, locationId ?? f.activeLocation);
            const rawPayout    = randInt(fish.payoutMin, fish.payoutMax);

            // Size variance: ±20% of base payout, adds flavor
            let sizeLabel = null;
            let sizeMultiplier = 1.0;
            if (fish.sizeVariance) {
                const roll = Math.random();
                if (roll < 0.15) {
                    sizeMultiplier = 0.75 + Math.random() * 0.10;
                    sizeLabel = 'Tiny';
                } else if (roll < 0.35) {
                    sizeMultiplier = 0.85 + Math.random() * 0.10;
                    sizeLabel = 'Small';
                } else if (roll < 0.65) {
                    sizeLabel = 'Average';
                } else if (roll < 0.85) {
                    sizeMultiplier = 1.10 + Math.random() * 0.10;
                    sizeLabel = 'Large';
                } else {
                    sizeMultiplier = 1.20 + Math.random() * 0.15;
                    sizeLabel = 'Trophy';
                }
            }
            const sizedPayout = Math.round(rawPayout * sizeMultiplier);

            // Critical catch
            const critChance     = calculateCritChance(user);
            const isCrit         = Math.random() < critChance;
            const critMultiplier = isCrit ? (1.5 + Math.random() * 1.0) : 1.0;
            const preModPayout   = Math.round(sizedPayout * critMultiplier);

            const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, preModPayout, location);

            // Special material drop
            let specialDrop = null;
            if (fish.specialDrop && Math.random() < (isCrit ? fish.specialDrop.chance * 2 : fish.specialDrop.chance)) {
                specialDrop = fish.specialDrop;
                const matKey = fish.specialDrop.itemId;
                if (f.materials[matKey] != null) f.materials[matKey] += 1;
                else f.materials[matKey] = 1;
            }

            // XP
            let xpGain = fish.xp;
            if (isCrit) xpGain = Math.round(xpGain * 1.5);
            if (f.activeXpScroll) xpGain = Math.round(xpGain * 1.5);

            applyDurabilityLoss(rod, 1);
            result.durabilityLost = 1;

            user.balance   += adjustedPayout;
            f.totalEarned  += adjustedPayout;
            f.dailyCoins   += adjustedPayout;
            if (adjustedPayout > f.bestPayout) f.bestPayout = adjustedPayout;

            f.successfulCasts += 1;
            f.consecutiveFails = 0;
            if (tier === 'legendary') f.legendaryCatches += 1;
            if (tier === 'event')     f.eventCatches     += 1;

            const lvResult = applyXp(user, xpGain);

            Object.assign(result, {
                fish, tier, rawPayout: sizedPayout, finalPayout: adjustedPayout,
                isCrit, critMultiplier: parseFloat(critMultiplier.toFixed(2)),
                sizeLabel, specialDrop, xpEarned: xpGain,
                levelUp: lvResult.leveledUp ? lvResult : null, cappedByHard
            });
        }

        if (rod.currentDurability <= 0) result.rodBroke = true;

    } else {
        const severity = rollFailureSeverity();
        applyDurabilityLoss(rod, severity.durLoss);
        result.durabilityLost = severity.durLoss;

        if (severity.injuryMs > 0) {
            f.injuryUntil = new Date(Date.now() + severity.injuryMs);
        }

        f.consecutiveFails += 1;

        let xpGain = severity.xp;
        if (f.activeXpScroll && xpGain > 0) xpGain = Math.round(xpGain * 1.5);
        if (xpGain > 0) {
            const lvResult = applyXp(user, xpGain);
            result.levelUp = lvResult.leveledUp ? lvResult : null;
        }

        result.xpEarned = xpGain;
        result.failure  = { severity, message: severity.msg };

        if (rod.currentDurability <= 0) result.rodBroke = true;
    }

    // Common post-cast updates
    f.totalCasts += 1;
    f.dailyCasts += 1;
    f.stamina    -= 1;
    f.lastCast    = new Date();

    tickConsumables(user);
    result.expiredBait     = baitBefore && !f.activeBait ? baitBefore : null;
    result.activeBaitAfter = f.activeBait;

    user.markModified('fishing');
    return result;
}

// ─── DAILY QUESTS ─────────────────────────────────────────────────────────────

function assignDailyFishQuests(user) {
    const f   = user.fishing;
    const now = Date.now();

    user.quests = user.quests.filter(q =>
        !q.questId.startsWith('fq_') ||
        (q.expiresAt && q.expiresAt.getTime() > now)
    );

    const activeCount = user.quests.filter(q => q.questId.startsWith('fq_')).length;
    if (activeCount > 0) return;

    const eligible = FISH_QUEST_TEMPLATES.filter(t =>
        f.level >= t.minLevel &&
        (t.type !== 'location_casts' || f.unlockedLocations.includes(t.location))
    );

    const shuffled  = eligible.slice().sort(() => Math.random() - 0.5);
    const toAssign  = shuffled.slice(0, DAILY_QUEST_COUNT);
    const expiresAt = new Date(now + LIMITS.DAILY_WINDOW_MS);

    for (const template of toAssign) {
        user.quests.push({ questId: template.id, progress: 0, completedAt: null, expiresAt });
    }

    if (toAssign.length) user.markModified('quests');
}

function updateFishQuestProgress(user, result, locationId) {
    const now        = Date.now();
    const fishQuests = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        !q.completedAt &&
        q.progress !== -1 &&
        q.expiresAt?.getTime() > now
    );

    if (!fishQuests.length) return;

    for (const quest of fishQuests) {
        const template = FISH_QUEST_TEMPLATES.find(t => t.id === quest.questId);
        if (!template) continue;

        switch (template.type) {
            case 'total_casts':
                quest.progress += 1;
                break;
            case 'rare_plus_catches':
                if (result.success && result.catchType === 'fish' &&
                    ['rare', 'epic', 'legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'epic_plus_catches':
                if (result.success && result.catchType === 'fish' &&
                    ['epic', 'legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'legendary_plus_catches':
                if (result.success && result.catchType === 'fish' &&
                    ['legendary', 'event'].includes(result.tier))
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
                else                quest.progress  = 0;
                break;
            case 'treasure_pulls':
                if (result.success && result.catchType === 'treasure') quest.progress += 1;
                break;
            case 'location_casts':
                if (locationId === template.location) quest.progress += 1;
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

function rodStatusEmoji(status) {
    return { good: '✅', degraded: '⚠️', condemned: '💀', broken: '❌' }[status] ?? '❓';
}

function durabilityBar(current, max, length = 10) {
    const filled = Math.max(0, Math.round((current / Math.max(1, max)) * length));
    return '█'.repeat(Math.min(filled, length)) + '░'.repeat(Math.max(0, length - filled));
}

module.exports = {
    ensureFishingData,
    getMaxStamina,
    applyStaminaRegen,
    msUntilNextStamina,
    applyDailyReset,
    calculateSuccessChance,
    calculateCritChance,
    rollCatchType,
    rollTier,
    rollFish,
    rollFailureSeverity,
    applyPayoutModifiers,
    applyDurabilityLoss,
    updateRodStatus,
    applyRepair,
    levelFromXp,
    getLevelData,
    xpToNextLevel,
    applyXp,
    activateConsumable,
    tickConsumables,
    executeCast,
    assignDailyFishQuests,
    updateFishQuestProgress,
    formatMs,
    rodStatusEmoji,
    durabilityBar
};
