'use strict';

const {
    PICKAXE_TIERS,
    PICKAXE_BY_TIER,
    PICKAXE_UPGRADES,
    DEPTHS,
    ORES,
    ORES_BY_TIER,
    MINER_LEVELS,
    LIMITS,
    PRESTIGE_BONUSES,
    MINE_QUEST_TEMPLATES
} = require('../data/mineData');
const { getStreakMultiplier } = require('../utils/streakMultiplier');

const DANGEROUS_DEPTH_IDS = new Set(['crystal_caves', 'the_abyss']);
const MINE_DEATH_RATE = 0.08;
const DAILY_QUEST_COUNT = 3;

// ─── INIT ────────────────────────────────────────────────────────────────────

function ensureMineData(user) {
    if (!user.mining) user.mining = {};
    const m = user.mining;

    if (m.stamina            == null) m.stamina            = 10;
    if (m.staminaLastRegen   == null) m.staminaLastRegen   = null;
    if (m.energyTonicsToday  == null) m.energyTonicsToday  = 0;
    if (m.lastTonicDayReset  == null) m.lastTonicDayReset  = null;
    if (m.xp                 == null) m.xp                 = 0;
    if (m.level              == null) m.level              = 1;
    if (m.prestige           == null) m.prestige            = 0;
    if (m.lastMine           == null) m.lastMine            = null;
    if (m.injuryUntil        == null) m.injuryUntil         = null;
    if (m.activeDepth        == null) m.activeDepth         = 'surface_quarry';
    if (!Array.isArray(m.unlockedDepths))       m.unlockedDepths      = ['surface_quarry'];
    if (m.equippedPickaxeIndex == null) m.equippedPickaxeIndex = -1;
    if (!Array.isArray(m.pickaxes))             m.pickaxes            = [];
    if (!m.charges)       m.charges      = {};
    if (!m.consumables)   m.consumables  = {};
    if (!m.materials)     m.materials    = {};
    if (m.activeMagnet         == null) m.activeMagnet         = null;
    if (m.activeMagnetMinesLeft == null) m.activeMagnetMinesLeft = 0;
    if (m.activeLamp           == null) m.activeLamp           = null;
    if (m.activeLampMinesLeft  == null) m.activeLampMinesLeft  = 0;
    if (m.activeInstinct       == null) m.activeInstinct       = false;
    if (m.activeXpScroll       == null) m.activeXpScroll       = false;
    if (m.sharpPick            == null) m.sharpPick            = false;
    if (m.totalMines           == null) m.totalMines           = 0;
    if (m.successfulMines      == null) m.successfulMines      = 0;
    if (m.totalEarned          == null) m.totalEarned          = 0;
    if (m.legendaryFinds       == null) m.legendaryFinds       = 0;
    if (m.eventFinds           == null) m.eventFinds           = 0;
    if (m.bestPayout           == null) m.bestPayout           = 0;
    if (m.consecutiveFails     == null) m.consecutiveFails     = 0;
    if (m.dailyCoins           == null) m.dailyCoins           = 0;
    if (m.dailyMines           == null) m.dailyMines           = 0;
    if (m.dailyWindowStart     == null) m.dailyWindowStart     = null;

    if (!m.unlockedDepths.includes('surface_quarry')) {
        m.unlockedDepths.push('surface_quarry');
    }
    user.markModified('mining');
}

// ─── STAMINA ─────────────────────────────────────────────────────────────────

function getMaxStamina(user) {
    const prestige = user.mining?.prestige ?? 0;
    const bonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)]?.staminaBonus ?? 0;
    return LIMITS.MAX_STAMINA_BASE + bonus;
}

function applyStaminaRegen(user) {
    const m = user.mining;
    const max = getMaxStamina(user);
    if (m.stamina >= max) {
        m.stamina = max;
        m.staminaLastRegen = new Date();
        user.markModified('mining');
        return;
    }
    if (!m.staminaLastRegen) {
        m.staminaLastRegen = new Date();
        user.markModified('mining');
        return;
    }
    const elapsed = Date.now() - m.staminaLastRegen.getTime();
    const intervals = Math.floor(elapsed / LIMITS.STAMINA_REGEN_MS);
    if (intervals <= 0) return;

    m.stamina = Math.min(max, m.stamina + intervals);
    m.staminaLastRegen = new Date(m.staminaLastRegen.getTime() + intervals * LIMITS.STAMINA_REGEN_MS);
    user.markModified('mining');
}

function msUntilNextStamina(user) {
    const m = user.mining;
    const max = getMaxStamina(user);
    if (m.stamina >= max) return 0;
    if (!m.staminaLastRegen) return LIMITS.STAMINA_REGEN_MS;
    const elapsed = Date.now() - m.staminaLastRegen.getTime();
    return Math.max(0, LIMITS.STAMINA_REGEN_MS - (elapsed % LIMITS.STAMINA_REGEN_MS));
}

// ─── DAILY WINDOW ────────────────────────────────────────────────────────────

function applyDailyReset(user) {
    const m = user.mining;
    const now = Date.now();
    if (!m.dailyWindowStart || now - m.dailyWindowStart.getTime() >= LIMITS.DAILY_WINDOW_MS) {
        m.dailyCoins        = 0;
        m.dailyMines        = 0;
        m.dailyWindowStart  = new Date(now);
        m.energyTonicsToday = 0;
        m.lastTonicDayReset = new Date(now);
        user.markModified('mining');
    }
}

// ─── SUCCESS FORMULA ─────────────────────────────────────────────────────────

function calculateSuccessChance(user, pickaxe, depth) {
    const m = user.mining;
    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];

    let chance = pickaxeData.successRate;

    // Level bonus
    chance += (m.level - 1) * 0.003;

    // Depth difficulty
    chance += depth.difficultyMod;

    // Active lamp
    if (m.activeLamp === 'miners_lamp') chance += 0.03;

    // Miner's instinct
    if (m.activeInstinct) chance += 0.10;

    // Upgrade: tempered edge
    if (pickaxe.upgrade === 'tempered_edge') {
        chance += PICKAXE_UPGRADES.tempered_edge.effect.successBonus;
    }

    // Durability penalty: ramps from 0 at 30% → −0.20 at 0% durability
    const durPct = pickaxe.currentDurability / pickaxe.maxDurability;
    if (durPct < 0.30) {
        chance -= (0.30 - durPct) * (0.20 / 0.30);
    }

    // Pity system
    const pityStacks = Math.min(m.consecutiveFails, LIMITS.PITY_CONSECUTIVE_FAILS);
    if (pityStacks > 0) {
        chance += pityStacks * LIMITS.PITY_BONUS_PER_STACK;
    }

    return Math.min(0.95, Math.max(0.10, chance));
}

// ─── CRIT CHANCE ─────────────────────────────────────────────────────────────

function calculateCritChance(user) {
    const m = user.mining;
    let crit = 0.03;

    const p = Math.min(m.prestige, PRESTIGE_BONUSES.length - 1);
    crit += PRESTIGE_BONUSES[p].critBonus;

    if (m.activeLamp === 'miners_lamp') crit += 0.05;
    if (m.sharpPick) crit += 0.01;

    // Level bonus: 1% per 10 levels
    crit += Math.floor(m.level / 10) * 0.01;

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

function rollTier(user, depth) {
    const m = user.mining;
    const w = { ...depth.tierWeights };

    // Magnet shifts weight from common → rare/epic
    if (m.activeMagnet === 'ore_magnet') {
        const shift = w.common * 0.08;
        w.common  = Math.max(0, w.common - shift);
        w.rare   += shift;
    } else if (m.activeMagnet === 'premium_magnet') {
        const shiftRare = w.common * 0.15;
        const shiftEpic = w.common * 0.05;
        w.common  = Math.max(0, w.common - shiftRare - shiftEpic);
        w.rare   += shiftRare;
        w.epic   += shiftEpic;
    }

    // Pickaxe rarity boost
    const equippedPickaxe = m.pickaxes[m.equippedPickaxeIndex];
    const pickaxeData = PICKAXE_BY_TIER[equippedPickaxe?.tier ?? 1];
    const rarityBoost = (pickaxeData?.rarityBoost ?? 0) + (
        equippedPickaxe?.upgrade === 'gem_lens'
            ? PICKAXE_UPGRADES.gem_lens.effect.rarityBonus : 0
    );
    if (rarityBoost > 0) {
        const shift = w.common * rarityBoost;
        w.common = Math.max(0, w.common - shift);
        w.rare  += shift * 0.6;
        w.epic  += shift * 0.3;
        w.legendary += shift * 0.1;
    }

    // Prestige rarity bonus
    const p = Math.min(m.prestige, PRESTIGE_BONUSES.length - 1);
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

// ─── ORE ROLL ────────────────────────────────────────────────────────────────

function rollOre(tier, depthId) {
    const pool = (ORES_BY_TIER[tier] ?? []).filter(o =>
        o.depths.includes('all') || o.depths.includes(depthId)
    );
    if (!pool.length) {
        const fallback = ORES_BY_TIER[tier];
        if (!fallback?.length) return ORES_BY_TIER['common'][0];
        return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── FAILURE SEVERITY ────────────────────────────────────────────────────────

const FAILURE_SEVERITIES = [
    { id: 'clean_miss', label: 'Clean Miss',    durLoss: 1, injuryMs: 0,                        xp: 0, msg: 'Your swing crumbled the face into dust — nothing worth taking.' },
    { id: 'clean_miss', label: 'Clean Miss',    durLoss: 1, injuryMs: 0,                        xp: 0, msg: 'The vein was a dead end. Not a chip worth keeping.' },
    { id: 'rockfall',   label: 'Rockfall',      durLoss: 2, injuryMs: 0,                        xp: 5, msg: 'Loose rocks tumbled from the ceiling. You dove clear.' },
    { id: 'rockfall',   label: 'Rockfall',      durLoss: 2, injuryMs: 0,                        xp: 5, msg: 'A tremor shook the tunnel and the vein collapsed.' },
    { id: 'stuck',      label: 'Pickaxe Stuck', durLoss: 5, injuryMs: 0,                        xp: 0, msg: 'Your pickaxe lodged deep in the rock face. You yanked it free at great cost.' },
    { id: 'cave_in',    label: 'Cave-in',       durLoss: 3, injuryMs: LIMITS.INJURY_PENALTY_MS, xp: 0, msg: 'A small cave-in forced you to retreat and rest!' }
];

function rollFailureSeverity() {
    return FAILURE_SEVERITIES[Math.floor(Math.random() * FAILURE_SEVERITIES.length)];
}

// ─── PAYOUT CALCULATION ───────────────────────────────────────────────────────

function applyPayoutModifiers(user, rawPayout, depth) {
    const m = user.mining;
    let payout = rawPayout;

    if (depth.payoutBonus > 0) payout *= (1 + depth.payoutBonus);

    const p = Math.min(m.prestige, PRESTIGE_BONUSES.length - 1);
    const presBonus = PRESTIGE_BONUSES[p].payoutBonus;
    if (presBonus > 0) payout *= (1 + presBonus);

    if (m.dailyMines >= LIMITS.DIM_RETURNS_THRESHOLD_3) {
        payout *= 0.55;
    } else if (m.dailyMines >= LIMITS.DIM_RETURNS_THRESHOLD_2) {
        payout *= 0.70;
    } else if (m.dailyMines >= LIMITS.DIM_RETURNS_THRESHOLD_1) {
        payout *= 0.85;
    }

    payout = Math.round(payout);

    if (m.dailyCoins >= LIMITS.DAILY_HARD_CAP) {
        return { adjustedPayout: 0, cappedByHard: true };
    }

    if (m.dailyCoins >= LIMITS.DAILY_SOFT_CAP) {
        payout = Math.round(payout * 0.50);
    }

    const remaining = LIMITS.DAILY_HARD_CAP - m.dailyCoins;
    payout = Math.min(payout, remaining);

    return { adjustedPayout: Math.max(0, payout), cappedByHard: false };
}

// ─── DURABILITY ───────────────────────────────────────────────────────────────

function applyDurabilityLoss(pickaxe, baseLoss) {
    let loss = baseLoss;
    if (pickaxe.upgrade === 'reinforced_handle') {
        loss = Math.max(1, loss - PICKAXE_UPGRADES.reinforced_handle.effect.durabilityReduction);
    }
    pickaxe.currentDurability = Math.max(0, pickaxe.currentDurability - loss);
    updatePickaxeStatus(pickaxe);
}

function updatePickaxeStatus(pickaxe) {
    if (pickaxe.currentDurability <= 0) {
        pickaxe.status = 'broken';
        return;
    }
    const ratio = pickaxe.maxDurability / pickaxe.baseDurability;
    if (ratio < 0.20)      pickaxe.status = 'condemned';
    else if (ratio < 0.50) pickaxe.status = 'degraded';
    else                   pickaxe.status = 'good';
}

function applyRepair(pickaxe, requestedAmount) {
    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
    if (!pickaxeData) throw new Error('Unknown pickaxe tier');

    if (pickaxe.status === 'condemned') {
        return { error: 'This pickaxe is condemned and cannot be repaired. Replace it.' };
    }
    if (pickaxe.status !== 'broken' && pickaxe.currentDurability >= pickaxe.maxDurability) {
        return { error: 'Pickaxe is already at full durability.' };
    }

    const needed = pickaxe.maxDurability - pickaxe.currentDurability;
    const amount = Math.min(requestedAmount ?? needed, needed);
    const units  = Math.ceil(amount / 20);
    const cost   = units * pickaxeData.repairCostPer20;

    pickaxe.currentDurability = Math.min(pickaxe.maxDurability, pickaxe.currentDurability + amount);

    const degradation = Math.floor(pickaxe.baseDurability * 0.10);
    pickaxe.maxDurability  = Math.max(Math.floor(pickaxe.baseDurability * 0.10), pickaxe.maxDurability - degradation);
    pickaxe.repairCount   += 1;
    pickaxe.currentDurability = Math.min(pickaxe.currentDurability, pickaxe.maxDurability);

    updatePickaxeStatus(pickaxe);

    return { cost, restoredAmount: amount, newStatus: pickaxe.status, condemned: pickaxe.status === 'condemned' };
}

// ─── LEVEL / XP ──────────────────────────────────────────────────────────────

function levelFromXp(totalXp) {
    let level = 1;
    for (const row of MINER_LEVELS) {
        if (totalXp >= row.xpRequired) level = row.level;
        else break;
    }
    return level;
}

function getLevelData(level) {
    return MINER_LEVELS[Math.min(level, MINER_LEVELS.length) - 1];
}

function xpToNextLevel(currentLevel, currentXp) {
    if (currentLevel >= MINER_LEVELS.length) return null;
    return MINER_LEVELS[currentLevel].xpRequired - currentXp;
}

function applyXp(user, xpGain) {
    const m = user.mining;
    const oldLevel = m.level;
    m.xp += xpGain;
    const newLevel = levelFromXp(m.xp);

    if (newLevel > oldLevel) {
        m.level = newLevel;
        user.markModified('mining');
        return { oldLevel, newLevel, leveledUp: true };
    }
    return { oldLevel, newLevel: oldLevel, leveledUp: false };
}

// ─── CONSUMABLE MANAGEMENT ───────────────────────────────────────────────────

function activateConsumable(user, consumableId) {
    const m = user.mining;
    const { CONSUMABLES } = require('../data/mineData');
    const def = CONSUMABLES[consumableId];
    if (!def) return { success: false, error: 'Unknown consumable.' };

    const stock = m.consumables[consumableId] ?? 0;
    if (stock <= 0) return { success: false, error: `You don't have any **${def.name}**.` };

    if (def.type === 'magnet') {
        if (m.activeMagnet) return { success: false, error: `You already have **${m.activeMagnet}** active. Wait for it to expire.` };
        m.consumables[consumableId] -= 1;
        m.activeMagnet          = consumableId;
        m.activeMagnetMinesLeft = def.minesLeft;
    } else if (def.type === 'lamp') {
        if (m.activeLamp) return { success: false, error: `You already have **${m.activeLamp}** active. Wait for it to expire.` };
        m.consumables[consumableId] -= 1;
        m.activeLamp          = consumableId;
        m.activeLampMinesLeft = def.minesLeft;
    } else if (def.type === 'instant' && consumableId === 'miners_instinct') {
        if (m.activeInstinct) return { success: false, error: `Miner's Instinct is already queued for your next mine.` };
        m.consumables[consumableId] -= 1;
        m.activeInstinct = true;
    } else if (def.type === 'instant' && consumableId === 'xp_scroll') {
        if (m.activeXpScroll) return { success: false, error: `An XP Scroll is already queued for your next mine.` };
        m.consumables[consumableId] -= 1;
        m.activeXpScroll = true;
    } else if (def.type === 'stamina') {
        const now = Date.now();
        const tonicWindowOk = m.lastTonicDayReset && (now - m.lastTonicDayReset.getTime() < LIMITS.DAILY_WINDOW_MS);
        if (!tonicWindowOk) {
            m.energyTonicsToday = 0;
            m.lastTonicDayReset = new Date(now);
        }
        if (m.energyTonicsToday >= LIMITS.ENERGY_TONICS_PER_DAY) {
            return { success: false, error: `You've already used ${LIMITS.ENERGY_TONICS_PER_DAY} Energy Tonics today.` };
        }
        const max = getMaxStamina(user);
        if (m.stamina >= max) return { success: false, error: `Your stamina is already full.` };
        m.consumables[consumableId] -= 1;
        m.stamina = Math.min(max, m.stamina + def.staminaRestore);
        m.energyTonicsToday += 1;
    } else if (def.type === 'repair') {
        return { success: false, error: `Use repair kits with \`/mineshop repair\`.` };
    } else {
        return { success: false, error: 'That item cannot be activated this way.' };
    }

    user.markModified('mining');
    return { success: true };
}

function tickConsumables(user) {
    const m = user.mining;
    if (m.activeMagnet) {
        m.activeMagnetMinesLeft -= 1;
        if (m.activeMagnetMinesLeft <= 0) {
            m.activeMagnet          = null;
            m.activeMagnetMinesLeft = 0;
        }
    }
    if (m.activeLamp) {
        m.activeLampMinesLeft -= 1;
        if (m.activeLampMinesLeft <= 0) {
            m.activeLamp          = null;
            m.activeLampMinesLeft = 0;
        }
    }
    m.activeInstinct = false;
    m.activeXpScroll = false;
    user.markModified('mining');
}

// ─── FULL MINE EXECUTION ─────────────────────────────────────────────────────

function executeMine(user, depthId) {
    const m       = user.mining;
    const depth   = DEPTHS[depthId ?? m.activeDepth];
    const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

    if (!depth || !pickaxe) {
        return {
            success: false, xpEarned: 0, durabilityLost: 0, pickaxeBroke: false,
            failure: { severity: { id: 'error', durLoss: 0, injuryMs: 0, xp: 0 }, message: 'Invalid mine state.' }
        };
    }

    const successChance = calculateSuccessChance(user, pickaxe, depth);
    const success = Math.random() < successChance;

    const magnetBefore = m.activeMagnet;
    const lampBefore   = m.activeLamp;

    const result = { success, xpEarned: 0, durabilityLost: 0, pickaxeBroke: false };

    if (success) {
        const tier   = rollTier(user, depth);
        const ore    = rollOre(tier, depthId ?? m.activeDepth);
        const rawPayout = randInt(ore.payoutMin, ore.payoutMax);

        const critChance     = calculateCritChance(user);
        const isCrit         = Math.random() < critChance;
        const critMultiplier = isCrit ? (1.5 + Math.random() * 1.0) : 1.0;

        const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
        const payoutBeforeMods = Math.round(rawPayout * critMultiplier * streakMult);
        const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, payoutBeforeMods, depth);

        let specialDrop = null;
        if (ore.specialDrop && Math.random() < (isCrit ? ore.specialDrop.chance * 2 : ore.specialDrop.chance)) {
            specialDrop = ore.specialDrop;
            const matKey = ore.specialDrop.itemId;
            if (m.materials[matKey] != null) {
                m.materials[matKey] += 1;
            } else {
                m.materials[matKey] = 1;
            }
        }

        let xpGain = ore.xp;
        if (isCrit) xpGain = Math.round(xpGain * 1.5);
        if (m.activeXpScroll) xpGain = Math.round(xpGain * 1.5);
        xpGain = Math.round(xpGain * streakMult);

        applyDurabilityLoss(pickaxe, 1);
        result.durabilityLost = 1;

        user.balance     += adjustedPayout;
        m.totalEarned    += adjustedPayout;
        m.dailyCoins     += adjustedPayout;
        if (adjustedPayout > m.bestPayout) m.bestPayout = adjustedPayout;

        m.successfulMines  += 1;
        m.consecutiveFails  = 0;
        if (tier === 'legendary') m.legendaryFinds += 1;
        if (tier === 'event')     m.eventFinds     += 1;

        const lvResult = applyXp(user, xpGain);

        Object.assign(result, {
            ore, tier, rawPayout, finalPayout: adjustedPayout,
            isCrit, critMultiplier: parseFloat(critMultiplier.toFixed(2)),
            specialDrop, xpEarned: xpGain,
            levelUp: lvResult.leveledUp ? lvResult : null,
            cappedByHard
        });

        if (pickaxe.currentDurability <= 0) result.pickaxeBroke = true;

    } else {
        const severity = rollFailureSeverity();
        applyDurabilityLoss(pickaxe, severity.durLoss);
        result.durabilityLost = severity.durLoss;

        if (severity.injuryMs > 0) {
            m.injuryUntil = new Date(Date.now() + severity.injuryMs);
        }

        m.consecutiveFails += 1;

        let xpGain = severity.xp;
        if (m.activeXpScroll && xpGain > 0) xpGain = Math.round(xpGain * 1.5);
        if (xpGain > 0) applyXp(user, xpGain);

        result.xpEarned = xpGain;
        result.failure  = { severity, message: severity.msg };

        if (pickaxe.currentDurability <= 0) result.pickaxeBroke = true;

        // Cave collapse event (dangerous depths only)
        if (DANGEROUS_DEPTH_IDS.has(depth.id) && !result.pickaxeBroke && Math.random() < MINE_DEATH_RATE) {
            pickaxe.currentDurability = 0;
            pickaxe.status = 'broken';
            result.pickaxeBroke = true;
            result.collapseEvent = { weaponName: pickaxe.name };
        }
    }

    m.totalMines  += 1;
    m.dailyMines  += 1;
    m.stamina     -= 1;
    m.lastMine     = new Date();

    tickConsumables(user);
    result.expiredMagnet     = magnetBefore && !m.activeMagnet ? magnetBefore : null;
    result.expiredLamp       = lampBefore   && !m.activeLamp   ? lampBefore   : null;
    result.activeMagnetAfter = m.activeMagnet;
    result.activeLampAfter   = m.activeLamp;

    user.markModified('mining');
    return result;
}

// ─── MINE DAILY QUESTS ───────────────────────────────────────────────────────

function assignDailyMineQuests(user) {
    const m = user.mining;
    const now = Date.now();

    user.quests = user.quests.filter(q =>
        !q.questId.startsWith('mq_') ||
        (q.expiresAt && q.expiresAt.getTime() > now)
    );

    const activeCount = user.quests.filter(q => q.questId.startsWith('mq_')).length;
    if (activeCount > 0) return;

    const eligible = MINE_QUEST_TEMPLATES.filter(t =>
        m.level >= t.minLevel &&
        (t.type !== 'depth_mines' || m.unlockedDepths.includes(t.depth))
    );

    const shuffled  = eligible.slice().sort(() => Math.random() - 0.5);
    const toAssign  = shuffled.slice(0, DAILY_QUEST_COUNT);
    const expiresAt = new Date(now + LIMITS.DAILY_WINDOW_MS);

    for (const template of toAssign) {
        user.quests.push({ questId: template.id, progress: 0, completedAt: null, expiresAt });
    }

    if (toAssign.length) user.markModified('quests');
}

function updateMineQuestProgress(user, result, depthId) {
    const now = Date.now();
    const mineQuests = user.quests.filter(q =>
        q.questId.startsWith('mq_') &&
        !q.completedAt &&
        q.progress !== -1 &&
        q.expiresAt?.getTime() > now
    );

    if (!mineQuests.length) return;

    for (const quest of mineQuests) {
        const template = MINE_QUEST_TEMPLATES.find(t => t.id === quest.questId);
        if (!template) continue;

        switch (template.type) {
            case 'total_mines':
                quest.progress += 1;
                break;
            case 'rare_plus_finds':
                if (result.success && ['rare', 'epic', 'legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'epic_plus_finds':
                if (result.success && ['epic', 'legendary', 'event'].includes(result.tier))
                    quest.progress += 1;
                break;
            case 'legendary_plus_finds':
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
            case 'depth_mines':
                if (depthId === template.depth) quest.progress += 1;
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

function pickaxeStatusEmoji(status) {
    return { good: '✅', degraded: '⚠️', condemned: '💀', broken: '❌' }[status] ?? '❓';
}

function durabilityBar(current, max, length = 10) {
    const filled = Math.round((current / max) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}

module.exports = {
    ensureMineData,
    getMaxStamina,
    applyStaminaRegen,
    msUntilNextStamina,
    applyDailyReset,
    calculateSuccessChance,
    calculateCritChance,
    rollTier,
    rollOre,
    rollFailureSeverity,
    applyPayoutModifiers,
    applyDurabilityLoss,
    updatePickaxeStatus,
    applyRepair,
    levelFromXp,
    getLevelData,
    xpToNextLevel,
    applyXp,
    activateConsumable,
    tickConsumables,
    executeMine,
    assignDailyMineQuests,
    updateMineQuestProgress,
    formatMs,
    pickaxeStatusEmoji,
    durabilityBar
};
