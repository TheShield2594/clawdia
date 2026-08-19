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
const { getPityBonus } = require('../utils/pityBonus');
const { hasIronWill, getMineDeepProspectorStaminaBonus, getArtificerMineStaminaBonus, getArtificerMineYieldBonus } = require('./synergyService');
const { MAX_STAMINA_UPGRADES } = require('../data/crossSystemData');
const { getBonusMultipliers } = require('../utils/prestige');
const { getGatheringYieldEffect, consumeEffect, getEffect, EFFECT_CONFIGS } = require('./effectsService');

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
    if (m.activeMagnet               == null) m.activeMagnet               = null;
    if (m.activeMagnetMinesLeft      == null) m.activeMagnetMinesLeft      = 0;
    if (m.activeLamp                 == null) m.activeLamp                 = null;
    if (m.activeLampMinesLeft        == null) m.activeLampMinesLeft        = 0;
    if (m.activeInstinct             == null) m.activeInstinct             = false;
    if (m.activeXpScroll             == null) m.activeXpScroll             = false;
    if (m.activeReinforcedTrapMinesLeft == null) m.activeReinforcedTrapMinesLeft = 0;
    if (m.sharpPick                  == null) m.sharpPick                  = false;
    if (m.consumables.reinforced_trap == null) m.consumables.reinforced_trap = 0;
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

    // Mine map: 10×10 flat array; initialise once then persist
    const MAP_SIZE = 10;
    if (!Array.isArray(m.mineMap) || m.mineMap.length !== MAP_SIZE * MAP_SIZE) {
        m.mineMap = new Array(MAP_SIZE * MAP_SIZE).fill(0);
    }
    if (m.mineMapRow == null) m.mineMapRow = 5;
    if (m.mineMapCol == null) m.mineMapCol = 5;
    if (m.mineLockActive == null) m.mineLockActive = false;

    user.markModified('mining');
}

// ─── STAMINA ─────────────────────────────────────────────────────────────────

function getMaxStamina(user) {
    const prestige = user.mining?.prestige ?? 0;
    const bonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)]?.staminaBonus ?? 0;
    // Deep Prospector and Artificer both advertise +1 max mining stamina. Neither
    // was ever read here, so both delivered nothing.
    const synergyBonus = getMineDeepProspectorStaminaBonus(user) + getArtificerMineStaminaBonus(user);
    // Permanent Stamina +1 from the shop, applied through /use.
    const purchased = Math.min(Math.max(0, user?.staminaUpgrades ?? 0), MAX_STAMINA_UPGRADES);
    return LIMITS.MAX_STAMINA_BASE + bonus + synergyBonus + purchased;
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
    chance += getPityBonus(m.consecutiveFails, LIMITS);

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

// Ascending rarity. Also the order rollOre walks backwards when a tier turns out
// to be unavailable at a depth.
const TIER_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];

/** The ores of `tier` that this depth can actually produce. */
function oresAtDepth(tier, depthId) {
    return (ORES_BY_TIER[tier] ?? []).filter(o => o.depths.includes('all') || o.depths.includes(depthId));
}

function hasOreAtDepth(tier, depthId) {
    return oresAtDepth(tier, depthId).length > 0;
}

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

    // Apply account-level prestige rare-tier shift bonus (P8-P10)
    const rareTierShift = getBonusMultipliers(user.accountPrestige?.rank ?? 0).rareTierShift;
    if (rareTierShift > 0) {
        const shift = w.common * rareTierShift;
        w.common = Math.max(0, w.common - shift);
        w.rare  += shift;
    }

    // Only tiers this depth actually has ore for are eligible. The weight table is
    // written to agree (see the invariant on DEPTHS), but every boost above adds to
    // w.rare/w.epic/w.legendary unconditionally, so a rarity boost would otherwise
    // resurrect a tier the depth was never meant to produce. weightedRoll normalises
    // by the surviving total, so dropping a tier redistributes rather than voids it.
    const items = TIER_ORDER
        .map(t => ({ tier: t, weight: w[t] ?? 0 }))
        .filter(i => i.weight > 0 && hasOreAtDepth(i.tier, depth.id));

    if (!items.length) return 'common';
    return weightedRoll(items).tier;
}

// ─── ORE ROLL ────────────────────────────────────────────────────────────────

/**
 * Picks an ore of `tier` from the depth's own pool. If the depth has no ore at that
 * tier the roll steps *down* the ladder rather than reaching outside the depth —
 * the old fallback used the unfiltered pool, which is how the starter quarry ended
 * up handing out Abyss-only legendaries. Callers should read the returned ore's
 * own `.tier`, since a downgrade makes it authoritative.
 */
function rollOre(tier, depthId) {
    const start = TIER_ORDER.indexOf(tier);
    for (let i = start < 0 ? 0 : start; i >= 0; i--) {
        const pool = oresAtDepth(TIER_ORDER[i], depthId);
        if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    return ORES_BY_TIER['common'][0];
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

/**
 * Returns { adjustedPayout, cappedByHard, gatheringYield, forfeited, softCapped,
 * fatigueMult }, where gatheringYield is { effect, label, emoji, chargesLeft } when
 * a charge was spent here.
 *
 * The three throttles below — fatigue past DIM_RETURNS_THRESHOLD_1, the halving past
 * DAILY_SOFT_CAP, and the DAILY_HARD_CAP floor — used to apply with nothing said. A
 * player's haul quietly shrank by 15%, then 50%, then to zero with no explanation
 * anywhere in the embed, which reads as the bot cheating rather than as a design.
 * `forfeited` is what the cap swallowed, so the caller can show it.
 */
function applyPayoutModifiers(user, rawPayout, depth) {
    const m = user.mining;
    let payout = rawPayout;

    if (depth.payoutBonus > 0) payout *= (1 + depth.payoutBonus);

    const p = Math.min(m.prestige, PRESTIGE_BONUSES.length - 1);
    const presBonus = PRESTIGE_BONUSES[p].payoutBonus;
    if (presBonus > 0) payout *= (1 + presBonus);

    // Artificer advertises +5% ore yield. Nothing read it until now.
    const artificerBonus = getArtificerMineYieldBonus(user);
    if (artificerBonus > 0) payout *= (1 + artificerBonus);

    const fatigueMult =
        m.dailyMines >= LIMITS.DIM_RETURNS_THRESHOLD_3 ? 0.55 :
        m.dailyMines >= LIMITS.DIM_RETURNS_THRESHOLD_2 ? 0.70 :
        m.dailyMines >= LIMITS.DIM_RETURNS_THRESHOLD_1 ? 0.85 : 1.00;
    payout *= fatigueMult;

    payout = Math.round(payout);

    // Hard cap: zero coins — check before consuming item charges
    if (m.dailyCoins >= LIMITS.DAILY_HARD_CAP) {
        return {
            adjustedPayout: 0, cappedByHard: true, gatheringYield: null,
            forfeited: payout, softCapped: true, fatigueMult, artificerRate: artificerBonus,
        };
    }

    // Applies the daily soft cap and clamps to the headroom left under the hard cap.
    const softCapped = m.dailyCoins >= LIMITS.DAILY_SOFT_CAP;
    const remaining  = LIMITS.DAILY_HARD_CAP - m.dailyCoins;
    const settle = raw => Math.max(0, Math.min(softCapped ? Math.round(raw * 0.50) : raw, remaining));

    const basePayout    = settle(payout);
    const doubledPayout = settle(payout * 2);
    const throttles     = { softCapped, fatigueMult, artificerRate: artificerBonus };

    // Silvered Talisman / Voidsteel Cache: 2x yield, consume 1 charge from whichever
    // is active. Only burn the charge when doubling actually pays more — within a
    // hair of the daily hard cap the headroom clamp swallows the bonus entirely, and
    // a charge that buys nothing shouldn't be spent.
    const gatherEffect = getGatheringYieldEffect(user);
    if (gatherEffect && doubledPayout > basePayout) {
        consumeEffect(user, gatherEffect);
        const cfg = EFFECT_CONFIGS[gatherEffect];
        return {
            ...throttles,
            forfeited:      Math.max(0, payout * 2 - doubledPayout),
            adjustedPayout: doubledPayout,
            cappedByHard:   false,
            gatheringYield: {
                effect:      gatherEffect,
                label:       cfg?.label ?? gatherEffect.replace(/_/g, ' '),
                emoji:       cfg?.emoji ?? '✨',
                chargesLeft: getEffect(user, gatherEffect)?.charges ?? 0,
            },
        };
    }

    return {
        ...throttles,
        forfeited:      Math.max(0, payout - basePayout),
        adjustedPayout: basePayout,
        cappedByHard:   false,
        gatheringYield: null,
    };
}

/**
 * How long until the daily window — caps, fatigue and Energy Tonic allowance —
 * rolls over. Null when the player has no window open yet.
 */
function msUntilDailyReset(user) {
    const start = user.mining?.dailyWindowStart;
    if (!start) return null;
    return Math.max(0, LIMITS.DAILY_WINDOW_MS - (Date.now() - start.getTime()));
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

/**
 * True once shop repairs have ground a pickaxe's durability ceiling below 20% of
 * its original. Derived from the durability ratio rather than `pickaxe.status`:
 * updatePickaxeStatus reports 'broken' whenever current durability hits 0, which
 * would otherwise mask condemnation and let a condemned pickaxe be repaired again
 * every time it breaks — an endless loop that costs a repair instead of a
 * replacement pickaxe.
 */
function isCondemned(pickaxe) {
    if (!pickaxe?.baseDurability) return false;
    return pickaxe.maxDurability / pickaxe.baseDurability < 0.20;
}

function updatePickaxeStatus(pickaxe) {
    if (pickaxe.currentDurability <= 0) {
        pickaxe.status = 'broken';
        return;
    }
    const ratio = pickaxe.maxDurability / pickaxe.baseDurability;
    if (isCondemned(pickaxe)) pickaxe.status = 'condemned';
    else if (ratio < 0.50)    pickaxe.status = 'degraded';
    else                      pickaxe.status = 'good';
}

/**
 * Prices one repair cycle without touching the pickaxe, so callers can check
 * affordability before anything is mutated.
 *
 * Returns { cost, amount } or { error }.
 */
function quoteRepair(pickaxe, requestedAmount) {
    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
    if (!pickaxeData) throw new Error('Unknown pickaxe tier');

    if (isCondemned(pickaxe)) {
        return { error: 'This pickaxe is condemned and cannot be repaired. Replace it.' };
    }
    if (pickaxe.status !== 'broken' && pickaxe.currentDurability >= pickaxe.maxDurability) {
        return { error: 'Pickaxe is already at full durability.' };
    }

    const needed = pickaxe.maxDurability - pickaxe.currentDurability;
    const amount = Math.min(requestedAmount ?? needed, needed);
    const units  = Math.ceil(amount / 20);

    return { cost: units * pickaxeData.repairCostPer20, amount };
}

function applyRepair(pickaxe, requestedAmount) {
    const quote = quoteRepair(pickaxe, requestedAmount);
    if (quote.error) return quote;
    const { cost, amount } = quote;

    pickaxe.currentDurability = Math.min(pickaxe.maxDurability, pickaxe.currentDurability + amount);

    const degradation = Math.floor(pickaxe.baseDurability * 0.10);
    pickaxe.maxDurability  = Math.max(Math.floor(pickaxe.baseDurability * 0.10), pickaxe.maxDurability - degradation);
    pickaxe.repairCount   += 1;
    pickaxe.currentDurability = Math.min(pickaxe.currentDurability, pickaxe.maxDurability);

    updatePickaxeStatus(pickaxe);

    return { cost, restoredAmount: amount, newStatus: pickaxe.status, condemned: isCondemned(pickaxe) };
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
    const { CROSS_CONSUMABLES } = require('../data/crossSystemData');
    const def = CONSUMABLES[consumableId] ?? CROSS_CONSUMABLES[consumableId];
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
    } else if (def.type === 'mine_immunity') {
        if ((m.activeReinforcedTrapMinesLeft ?? 0) > 0) {
            return { success: false, error: `A Reinforced Trap is already active (${m.activeReinforcedTrapMinesLeft} mines left).` };
        }
        m.consumables[consumableId] -= 1;
        m.activeReinforcedTrapMinesLeft = def.minesLeft;
    } else if (def.type === 'defense' && consumableId === 'mine_lock') {
        if (m.mineLockActive) {
            return { success: false, error: 'Your mine already has an active **Mine Lock**. It stays armed until a raider trips it.' };
        }
        m.consumables[consumableId] -= 1;
        m.mineLockActive = true;
    } else if (def.type === 'repair') {
        return { success: false, error: `Use repair kits with \`/mine shop repair\`.` };
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
    if ((m.activeReinforcedTrapMinesLeft ?? 0) > 0) {
        m.activeReinforcedTrapMinesLeft -= 1;
    }
    m.activeInstinct = false;
    m.activeXpScroll = false;
    user.markModified('mining');
}

// ─── FULL MINE EXECUTION ─────────────────────────────────────────────────────

function executeMine(user, depthId, options = {}) {
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
        const rolledTier = rollTier(user, depth);
        const ore        = rollOre(rolledTier, depthId ?? m.activeDepth);
        // The ore's own tier is authoritative: rollOre may have stepped down to stay
        // inside the depth, and the find counters, quest progress, rarity ribbon and
        // server announcement all have to describe the ore actually handed out.
        const tier       = ore.tier;
        const rawPayout  = randInt(ore.payoutMin, ore.payoutMax);

        const critChance     = calculateCritChance(user);
        const isCrit         = Math.random() < critChance;
        const critMultiplier = isCrit ? (1.5 + Math.random() * 1.0) : 1.0;

        const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
        const payoutBeforeMods = Math.round(rawPayout * critMultiplier * streakMult);
        const {
            adjustedPayout, cappedByHard, gatheringYield, forfeited, softCapped, fatigueMult,
            artificerRate,
        } = applyPayoutModifiers(user, payoutBeforeMods, depth);

        let specialDrop = null;
        const mineDropChance = (isCrit ? ore.specialDrop?.chance * 2 : ore.specialDrop?.chance ?? 0) * (options.marketplaceActive ? 1.10 : 1.0);
        if (ore.specialDrop && Math.random() < mineDropChance) {
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
        // bestPayout is deliberately NOT booked here: the intensity multiplier,
        // the yield bonuses and the cave-in resolution all still run in mine.js,
        // so only the caller knows what the player actually walked away with.

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
            cappedByHard,
            gatheringYield,
            streakMult,
            // What the daily throttles took, so the embed can account for it rather
            // than leaving the player to notice their haul shrinking on its own.
            forfeited, softCapped, fatigueMult, artificerRate,
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
        let lvResult = null;
        if (xpGain > 0) lvResult = applyXp(user, xpGain);

        result.xpEarned = xpGain;
        result.levelUp  = lvResult?.leveledUp ? lvResult : null;
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

    // ── Depth Risk System (intensity 1–5 selected before digging) ────────────
    if (options.intensity && result.success) {
        const { multiplier, caveInRisk, durLoss: intensityDurLoss } = options.intensity;
        result.intensityLevel = options.intensity;

        // Check for cave-in immunity (Reinforced Trap consumable or Iron Will synergy)
        const trapActive = (m.activeReinforcedTrapMinesLeft ?? 0) > 0;
        const ironWillBlocks = hasIronWill(user) &&
            pickaxe.currentDurability / pickaxe.maxDurability < 0.50;
        const caveInBlocked = trapActive || ironWillBlocks;

        if (caveInRisk > 0 && Math.random() < caveInRisk && !caveInBlocked) {
            // Cave-in: flag it and store at-risk payout; mine.js resolves interactively.
            result.caveIn        = true;
            result.caveInDur     = intensityDurLoss;
            // What executeMine has already credited, and what mine.js reverses if the
            // player flees.
            result.caveInPayout  = result.finalPayout ?? 0;
            // The multiplier the vein read earned is held in escrow, not destroyed.
            // Cave-in and the multiplier used to be exclusive branches, so reading the
            // vein perfectly, caving in, and spending a blast charge to dig clear paid
            // exactly the same as a one-in-three read — the charge bought back a haul
            // stripped of the very bonus it was risked for. mine.js pays this out only
            // on a successful escape.
            result.caveInEscrow  = multiplier !== 1.0 && result.finalPayout
                ? Math.round(result.finalPayout * (multiplier - 1.0))
                : 0;
            // Durability loss applied here regardless of player choice
            applyDurabilityLoss(pickaxe, intensityDurLoss);
            if (pickaxe.currentDurability <= 0) { pickaxe.status = 'broken'; result.pickaxeBroke = true; }
        } else if (multiplier !== 1.0 && result.finalPayout) {
            // Apply multiplier, clamped so it doesn't exceed the daily hard cap
            const rawBonus      = Math.round(result.finalPayout * (multiplier - 1.0));
            const remainingCap  = Math.max(0, LIMITS.DAILY_HARD_CAP - m.dailyCoins);
            const bonus         = Math.min(rawBonus, remainingCap);
            user.balance   += bonus;
            m.totalEarned  += bonus;
            m.dailyCoins   += bonus;
            result.finalPayout += bonus;
            // Extra durability loss at higher intensities
            if (intensityDurLoss > 1) {
                applyDurabilityLoss(pickaxe, intensityDurLoss - 1); // -1 because base already applied
                if (pickaxe.currentDurability <= 0) { pickaxe.status = 'broken'; result.pickaxeBroke = true; }
            }
        }
    }

    // An empty vein costs time and pickaxe wear but no stamina: a dry run should
    // burn your afternoon, not your ability to keep playing. Every harsher tier
    // still costs a point.
    const staminaSpared = !success && result.failure?.severity?.id === 'clean_miss';
    result.staminaSpared = staminaSpared;

    m.totalMines  += 1;
    m.dailyMines  += 1;
    if (!staminaSpared) m.stamina -= 1;
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

// ─── MINE MAP ─────────────────────────────────────────────────────────────────

const MAP_SIZE = 10;
// Cell codes
const CELL = { ROCK: 0, DUG: 1, ORE: 2, CAVE_IN: 3 };

function updateMineMap(user, result) {
    const m = user.mining;
    if (!Array.isArray(m.mineMap) || m.mineMap.length !== MAP_SIZE * MAP_SIZE) {
        m.mineMap = new Array(MAP_SIZE * MAP_SIZE).fill(0);
    }

    const row = m.mineMapRow ?? 5;
    const col = m.mineMapCol ?? 5;
    const idx = row * MAP_SIZE + col;

    if (result.caveIn) {
        m.mineMap[idx] = CELL.CAVE_IN;
    } else if (result.success && result.ore) {
        m.mineMap[idx] = CELL.ORE;
    } else {
        m.mineMap[idx] = CELL.DUG;
    }

    // Move miner to an adjacent unexplored cell if possible; otherwise wander freely
    const adjacent = [
        { r: row - 1, c: col }, { r: row + 1, c: col },
        { r: row, c: col - 1 }, { r: row, c: col + 1 }
    ].filter(({ r, c }) => r >= 0 && r < MAP_SIZE && c >= 0 && c < MAP_SIZE);

    const unexplored = adjacent.filter(({ r, c }) => m.mineMap[r * MAP_SIZE + c] === CELL.ROCK);
    const candidates = unexplored.length ? unexplored : adjacent;
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    m.mineMapRow = next.r;
    m.mineMapCol = next.c;

    user.markModified('mining');
}

function renderMineMap(user) {
    const m = user.mining;
    const EMOJI = ['🪨', '⬛', '💎', '💥'];
    const rows = [];
    const row = m.mineMapRow ?? 5;
    const col = m.mineMapCol ?? 5;

    for (let r = 0; r < MAP_SIZE; r++) {
        let line = '';
        for (let c = 0; c < MAP_SIZE; c++) {
            if (r === row && c === col) {
                line += '⛏️';
            } else {
                line += EMOJI[m.mineMap[r * MAP_SIZE + c] ?? 0];
            }
        }
        rows.push(line);
    }
    return rows.join('\n');
}

// ─── RAIDABLE MATERIALS ───────────────────────────────────────────────────────
//
// Raiding used to take from a separate `oreStash` map that was written alongside
// `materials` on every drop and never spent by its owner. That made a raid a pure
// mint: the defender's real material pile — the one `/craft` spends — was untouched
// while the raider was credited real materials out of nothing, and the Mine Lock
// they were sold defended a pile that cost nothing to lose.
//
// Raids now move materials between two real stocks, so nothing is created. The
// haul is bounded on both sides: only the defender's largest piles are exposed,
// no single material gives up more than a few units, and a miner's last unit of
// anything is never taken.

const RAID_MAX_MATERIAL_TYPES = 5;
const RAID_MAX_PER_MATERIAL   = 3;
const RAID_MIN_HOLDING        = 2;

/**
 * The materials a raid could reach right now: the defender's biggest piles, minus
 * anything they hold only one of. Sorted largest-first, then by id so the exposure
 * a defender sees on `/mine map` is the same set a raider hits.
 */
function getRaidableMaterials(user) {
    const materials = user.mining?.materials ?? {};
    return Object.entries(materials)
        .filter(([, qty]) => qty >= RAID_MIN_HOLDING)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, RAID_MAX_MATERIAL_TYPES);
}

function hasRaidableMaterials(user) {
    return getRaidableMaterials(user).length > 0;
}

/**
 * What a raid at `stealFraction` would take, as [{ matId, take }]. Every entry
 * takes at least 1 (the pile is known to hold 2+) and at most RAID_MAX_PER_MATERIAL,
 * so a long-standing miner's hoard can be chipped at but never cleaned out.
 */
function planRaidHaul(user, stealFraction) {
    return getRaidableMaterials(user).map(([matId, qty]) => ({
        matId,
        take: Math.min(RAID_MAX_PER_MATERIAL, Math.max(1, Math.floor(qty * stealFraction))),
    }));
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
    hasOreAtDepth,
    rollFailureSeverity,
    applyPayoutModifiers,
    msUntilDailyReset,
    applyDurabilityLoss,
    updatePickaxeStatus,
    isCondemned,
    quoteRepair,
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
    durabilityBar,
    updateMineMap,
    renderMineMap,
    getRaidableMaterials,
    hasRaidableMaterials,
    planRaidHaul,
    RAID_MAX_MATERIAL_TYPES,
    RAID_MAX_PER_MATERIAL,
    RAID_MIN_HOLDING
};
