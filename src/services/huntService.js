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
    HUNT_QUEST_TEMPLATES,
    TROPHY_QUALITIES,
    APEX_TYPES,
    FIELD_TROPHIES
} = require('../data/huntData');
const { hasEffect, consumeEffect, getEffect, getGatheringYieldEffect, EFFECT_CONFIGS } = require('./effectsService');
const { getStreakMultiplier } = require('../utils/streakMultiplier');
const { getPityBonus } = require('../utils/pityBonus');
const { getHuntSynergyStaminaBonus, getHuntWayfinderStaminaBonus } = require('./synergyService');
const { MAX_STAMINA_UPGRADES } = require('../data/crossSystemData');
const { getBonusMultipliers } = require('../utils/prestige');

// Zones where a critical failure can destroy your weapon (death event)
const DANGEROUS_ZONE_IDS = new Set(['desert_wastes', 'arctic_tundra', 'murky_swamp', 'legendary_peaks']);
const HUNT_DEATH_RATE = 0.08;

const DAILY_QUEST_COUNT = 3;

// Field Trophies: permanent, once-only upgrades crafted from a zone's own
// materials. Each zone's drop table terminates in one of these, which is what
// gives the deeper zones' trophies a reason to exist.
const FIELD_TROPHY_FLAGS = Object.keys(FIELD_TROPHIES);

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
    if (h.quickHunt            == null) h.quickHunt            = false;
    if (h.luckyPaw             == null) h.luckyPaw             = false;
    if (h.precisionScope       == null) h.precisionScope       = false;
    // Field Trophies — one permanent per zone, crafted from that zone's materials.
    for (const flag of FIELD_TROPHY_FLAGS) {
        if (h[flag] == null) h[flag] = false;
    }
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
    // Outdoorsman and Wayfinder both advertise +1 max hunt stamina; they stack,
    // exactly as Deep Prospector and Artificer do on mining.
    const synergyBonus = getHuntSynergyStaminaBonus(user) + getHuntWayfinderStaminaBonus(user);
    const trophyBonus  = user.hunt?.woodlandInstinct ? 1 : 0;
    // Permanent Stamina +1 from the shop, applied through /use.
    const purchased = Math.min(Math.max(0, user?.staminaUpgrades ?? 0), MAX_STAMINA_UPGRADES);
    return LIMITS.MAX_STAMINA_BASE + bonus + synergyBonus + trophyBonus + purchased;
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

/** Ms until the rolling 24h daily window rolls over (0 if it already has). */
function msUntilDailyReset(h) {
    if (!h?.dailyWindowStart) return 0;
    const elapsed = Date.now() - h.dailyWindowStart.getTime();
    return Math.max(0, LIMITS.DAILY_WINDOW_MS - elapsed);
}

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
    chance += getPityBonus(h.consecutiveFails, LIMITS);

    return Math.min(0.95, Math.max(0.10, chance));
}

// ─── CRIT CHANCE ─────────────────────────────────────────────────────────────

function calculateCritChance(user, traits = []) {
    const h = user.hunt;
    let crit = 0.03;

    // Prestige bonus
    const p = Math.min(h.prestige, PRESTIGE_BONUSES.length - 1);
    crit += PRESTIGE_BONUSES[p].critBonus;

    // Luck charm — spectral trait halves its contribution
    if (h.activeCharm === 'luck_charm') {
        crit += traits.includes('spectral') ? 0.025 : 0.05;
    }

    // Permanent lucky paw upgrade
    if (h.luckyPaw) crit += 0.01;

    // Level bonus: 1% per 10 levels
    crit += Math.floor(h.level / 10) * 0.01;

    return Math.min(LIMITS.MAX_CRIT_CHANCE, crit);
}

/**
 * Folds the aim phase's grade into a crit chance.
 *
 * The aim bonus moves in both directions now: a shot taken inside the window
 * adds to crit chance, one rushed before the window opened takes a little off.
 * The old guard was `aimBonus > 0`, which silently discarded any penalty — fine
 * while an early shot was impossible, wrong now that it is a decision the player
 * makes. Clamped at both ends, so a hunter with almost no crit chance to lose
 * cannot be pushed below zero and the cap still holds.
 */
function applyAimBonus(critChance, aimBonus = 0) {
    if (!aimBonus) return critChance;
    return Math.min(LIMITS.MAX_CRIT_CHANCE, Math.max(0, critChance + aimBonus));
}

// ─── TROPHY QUALITY ──────────────────────────────────────────────────────────

/**
 * Rolls a trophy quality tier for a successful hunt.
 * Weights are shifted toward higher quality by weapon tier, crits, and consumables.
 */
function rollTrophyQuality(user, weapon, isCrit) {
    const h = user.hunt;

    // Base weights: [poor, normal, good, pristine, mythic]
    const w = [25, 45, 18, 9, 3];

    // Weapon tier shifts weight off poor/normal and onto good+. Scaled by progress
    // along the whole tier ladder rather than by raw tier number, so the curve keeps
    // its shape if tiers are ever added — the previous per-tier steps were tuned for
    // a 5-tier ladder and would drive `poor` to 0 past T13.
    const tierProgress = WEAPON_TIERS.length > 1
        ? (weapon.tier - 1) / (WEAPON_TIERS.length - 1)   // 0 at T1 → 1 at max tier
        : 0;
    w[0] = Math.max(0, w[0] - Math.round(tierProgress * 18));
    w[1] = Math.max(0, w[1] - Math.round(tierProgress * 10));
    w[2] += Math.round(tierProgress * 14);
    w[3] += Math.round(tierProgress * 10);
    w[4] += Math.round(tierProgress * 4);

    // Critical hit: significant quality boost
    if (isCrit) {
        w[0] = Math.max(0, w[0] - 5);
        w[1] = Math.max(0, w[1] - 5);
        w[2] += 3;
        w[3] += 5;
        w[4] += 2;
    }

    // Luck charm
    if (h.activeCharm === 'luck_charm') {
        w[0] = Math.max(0, w[0] - 3);
        w[2] += 1;
        w[3] += 1;
        w[4] += 1;
    }

    // Lucky paw permanent upgrade
    if (h.luckyPaw) {
        w[0] = Math.max(0, w[0] - 1);
        w[3] += 1;
    }

    // Rifled barrel upgrade improves shot precision → quality
    if (weapon.upgrade === 'rifled_barrel') {
        w[0] = Math.max(0, w[0] - 2);
        w[2] += 1;
        w[3] += 1;
    }

    const total = w.reduce((s, v) => s + v, 0);
    let r = Math.random() * total;
    for (let i = 0; i < TROPHY_QUALITIES.length; i++) {
        r -= w[i];
        if (r <= 0) return TROPHY_QUALITIES[i];
    }
    return TROPHY_QUALITIES[TROPHY_QUALITIES.length - 1];
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
 * How many hunts without a rare+ kill before the zone guarantees one.
 *
 * Scaled per zone rather than flat: a single global threshold tuned for the
 * starter zone's 18% rare+ rate is unreachable everywhere else — at Legendary
 * Peaks' 63% a 50-hunt dry streak is a 1-in-10^16 event, so the promise the
 * pity bar makes would never once be kept. Each zone's number is set so a dry
 * streak is a comparably rare tail event wherever you hunt.
 */
function getRarePityThreshold(zone) {
    return zone?.rarePity ?? LIMITS.RARE_PITY_GUARANTEE;
}

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

    // Apply account-level prestige rare-tier shift bonus (P8-P10)
    const rareTierShift = getBonusMultipliers(user.accountPrestige?.rank ?? 0).rareTierShift;
    if (rareTierShift > 0) {
        const shift = w.common * rareTierShift;
        w.common = Math.max(0, w.common - shift);
        w.rare  += shift;
    }

    // Stormcaller's Totem: mythical prey stalks every zone, including the starter
    // forest where the event weight is otherwise zero.
    if (h.stormcallersTotem) {
        w.event = (w.event ?? 0) + LIMITS.TOTEM_EVENT_WEIGHT;
    }

    // Precision Scope permanent upgrade (+2% rarity boost)
    if (h.precisionScope) {
        const scopeShift = w.common * 0.02;
        w.common = Math.max(0, w.common - scopeShift);
        w.rare  += scopeShift * 0.6;
        w.epic  += scopeShift * 0.3;
        w.legendary += scopeShift * 0.1;
    }

    // Pity guarantee: at the zone's sinceRare threshold, force rare+ by zeroing out
    // common/uncommon.
    if ((user.hunt.sinceRare ?? 0) >= getRarePityThreshold(zone)) {
        w.common   = 0;
        w.uncommon = 0;
        if ((w.rare ?? 0) + (w.epic ?? 0) + (w.legendary ?? 0) + (w.event ?? 0) === 0) {
            w.rare = 1;
        }
    }

    const tiers = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];
    const items = tiers.map(t => ({ tier: t, weight: w[t] ?? 0 })).filter(i => i.weight > 0);
    return weightedRoll(items).tier;
}

// ─── ANIMAL ROLL ─────────────────────────────────────────────────────────────

/**
 * Rolls the prey for a hunt — tier first, then a specific animal — *before*
 * the approach prompt, so the prompt can describe the animal that is actually
 * there and key its correct answer on that animal's traits. The roll used to
 * live inside executeHunt, which runs after the prompt was answered: the hint
 * described a deer while the player shot a squirrel, a crow, or a Golden Fox.
 *
 * Pass the result to executeHunt as options.encounter.
 */
function rollHuntEncounter(user, zoneId) {
    const resolvedZoneId = zoneId ?? user.hunt.activeZone;
    const zone = ZONES[resolvedZoneId];
    // Same contract as quoteRepair's unknown tier: callers validate the zone
    // first, so an unknown one here is a programming error — fail loudly
    // rather than dereferencing undefined inside rollTier.
    if (!zone) throw new Error(`Unknown hunt zone: ${resolvedZoneId}`);
    const tier = rollTier(user, zone);
    return { tier, animal: rollAnimal(tier, resolvedZoneId) };
}

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

// Payout decay by daily hunt count, steepest band first.
const DIM_RETURNS_BANDS = [
    { threshold: LIMITS.DIM_RETURNS_THRESHOLD_3, multiplier: 0.55 },
    { threshold: LIMITS.DIM_RETURNS_THRESHOLD_2, multiplier: 0.70 },
    { threshold: LIMITS.DIM_RETURNS_THRESHOLD_1, multiplier: 0.85 },
];

/** The diminishing-returns band a hunter is in, and where the next one starts. */
function getDiminishingReturns(dailyHunts) {
    const band = DIM_RETURNS_BANDS.find(b => dailyHunts >= b.threshold);
    const next = [...DIM_RETURNS_BANDS].reverse().find(b => dailyHunts < b.threshold);
    return {
        multiplier: band?.multiplier ?? 1,
        threshold:  band?.threshold ?? 0,
        nextAt:     next?.threshold ?? null,
        nextMultiplier: next?.multiplier ?? null,
    };
}

/**
 * Applies anti-exploit modifiers to a raw payout:
 *   - Prestige payout bonus
 *   - Zone payout bonus
 *   - Diminishing returns (daily hunt count)
 *   - Daily coin caps (soft and hard)
 *
 * `options.reuseGatheringYield` applies a doubling that a charge already paid
 * for earlier in the same hunt rather than spending a second one — the apex
 * bonus rides on the charge the kill itself spent.
 *
 * Returns { adjustedPayout, cappedByHard, gatheringYield }, where gatheringYield
 * is { effect, label, emoji, chargesLeft } when a charge was spent here.
 */
function applyPayoutModifiers(user, rawPayout, zone, options = {}) {
    const h = user.hunt;
    let payout = rawPayout;

    // Zone bonus (e.g. Legendary Peaks +20%)
    if (zone.payoutBonus > 0) payout *= (1 + zone.payoutBonus);

    // Prestige payout bonus
    const p = Math.min(h.prestige, PRESTIGE_BONUSES.length - 1);
    const presBonus = PRESTIGE_BONUSES[p].payoutBonus;
    if (presBonus > 0) payout *= (1 + presBonus);

    // What the kill is worth before the day's own penalties take their cut. Kept
    // so the embed can show the hunter what was taken and why — a payout that
    // quietly shrinks by up to 72% reads as bad luck or a stealth nerf.
    const grossPayout = Math.round(payout);

    // Diminishing returns based on daily hunt count
    const dimReturns = getDiminishingReturns(h.dailyHunts);
    payout *= dimReturns.multiplier;

    payout = Math.round(payout);

    // Hard cap: zero coins — check before consuming item charges. Report what the
    // kill was worth so the embed can name the forfeited amount instead of
    // striking through a zero.
    if (h.dailyCoins >= LIMITS.DAILY_HARD_CAP) {
        return { adjustedPayout: 0, cappedByHard: true, forfeitedPayout: grossPayout };
    }

    // Applies the daily soft cap and clamps to the headroom left under the hard cap.
    const softCapped = h.dailyCoins >= LIMITS.DAILY_SOFT_CAP;
    const remaining  = LIMITS.DAILY_HARD_CAP - h.dailyCoins;
    const settle = raw => Math.max(0, Math.min(softCapped ? Math.round(raw * 0.50) : raw, remaining));

    const basePayout    = settle(payout);
    const doubledPayout = settle(payout * 2);

    /** Which of the day's penalties actually bit, and by how much. */
    const reportFor = (net, doubled) => {
        const gross = doubled ? grossPayout * 2 : grossPayout;
        return {
            grossPayout: gross,
            dimReturns:  dimReturns.multiplier < 1 ? dimReturns : null,
            softCapped,
            // The headroom clamp only shows up as its own line when it took more
            // than the soft cap already had.
            headroomClamped: net < (softCapped ? Math.round((doubled ? payout * 2 : payout) * 0.50)
                                              : (doubled ? payout * 2 : payout)),
            lostToDaily: Math.max(0, gross - net),
        };
    };

    // A doubling already paid for earlier this hunt — no second charge.
    if (options.reuseGatheringYield) {
        return {
            adjustedPayout: doubledPayout,
            cappedByHard:   false,
            gatheringYield: null,
            dailyReport:    reportFor(doubledPayout, true),
        };
    }

    // Silvered Talisman / Voidsteel Cache: 2x yield, consume 1 charge from whichever
    // is active. Only burn the charge when doubling actually pays more — within a
    // hair of the daily hard cap the headroom clamp swallows the bonus entirely, and
    // a charge that buys nothing shouldn't be spent.
    const gatherEffect = getGatheringYieldEffect(user);
    if (gatherEffect && doubledPayout > basePayout) {
        consumeEffect(user, gatherEffect);
        const cfg = EFFECT_CONFIGS[gatherEffect];
        return {
            adjustedPayout: doubledPayout,
            cappedByHard:   false,
            gatheringYield: {
                effect:      gatherEffect,
                label:       cfg?.label ?? gatherEffect.replace(/_/g, ' '),
                emoji:       cfg?.emoji ?? '✨',
                chargesLeft: getEffect(user, gatherEffect)?.charges ?? 0,
            },
            dailyReport: reportFor(doubledPayout, true),
        };
    }

    return {
        adjustedPayout: basePayout,
        cappedByHard:   false,
        gatheringYield: null,
        dailyReport:    reportFor(basePayout, false),
    };
}

// ─── DURABILITY ───────────────────────────────────────────────────────────────

/**
 * Deducts durability from a weapon after a hunt.
 *
 * The reinforced stock upgrade and `extraReduction` (the Insulated Kit field
 * trophy) each shave a point off; the floor of 1 applies once, after both, so
 * owning them together is worth more than either alone.
 */
function applyDurabilityLoss(weapon, baseLoss, extraReduction = 0) {
    let loss = baseLoss;
    if (weapon.upgrade === 'reinforced_stock') {
        loss -= WEAPON_UPGRADES.reinforced_stock.effect.durabilityReduction;
    }
    loss = Math.max(1, loss - extraReduction);
    weapon.currentDurability = Math.max(0, weapon.currentDurability - loss);
    updateWeaponStatus(weapon);
}

/**
 * True once shop repairs have ground a weapon's durability ceiling below 20% of
 * its original. Derived from the durability ratio rather than `weapon.status`:
 * updateWeaponStatus reports 'broken' whenever current durability hits 0, which
 * would otherwise mask condemnation and let a condemned weapon be repaired again
 * every time it breaks.
 */
function isCondemned(weapon) {
    if (!weapon?.baseDurability) return false;
    return weapon.maxDurability / weapon.baseDurability < 0.20;
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
    if (isCondemned(weapon))  weapon.status = 'condemned';
    else if (ratio < 0.50)    weapon.status = 'degraded';
    else                      weapon.status = 'good';
}

/**
 * Prices one repair cycle without touching the weapon, so callers can check
 * affordability before anything is mutated.
 *
 * Returns { cost, amount } or { error }.
 */
function quoteRepair(weapon, requestedAmount) {
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    if (!weaponData) throw new Error('Unknown weapon tier');

    if (isCondemned(weapon)) {
        return { error: 'This weapon is condemned and cannot be repaired. Replace it.' };
    }
    if (weapon.status !== 'broken' && weapon.currentDurability >= weapon.maxDurability) {
        return { error: 'Weapon is already at full durability.' };
    }

    const needed = weapon.maxDurability - weapon.currentDurability;
    const amount = Math.min(requestedAmount ?? needed, needed);
    const units  = Math.ceil(amount / 20);

    return { cost: units * weaponData.repairCostPer20, amount };
}

/**
 * Applies one repair cycle to a weapon:
 *   - Restores up to `amount` durability (capped at maxDurability)
 *   - Permanently degrades maxDurability by 10% of baseDurability
 *
 * Returns { cost, restoredAmount, newStatus, condemned }
 */
function applyRepair(weapon, requestedAmount) {
    const quote = quoteRepair(weapon, requestedAmount);
    if (quote.error) return quote;
    const { cost, amount } = quote;

    // Restore durability
    weapon.currentDurability = Math.min(weapon.maxDurability, weapon.currentDurability + amount);

    // Degrade max durability by 10% of base per repair cycle
    const degradation = Math.floor(weapon.baseDurability * 0.10);
    weapon.maxDurability  = Math.max(Math.floor(weapon.baseDurability * 0.10), weapon.maxDurability - degradation);
    weapon.repairCount   += 1;

    // Cap current to new max
    weapon.currentDurability = Math.min(weapon.currentDurability, weapon.maxDurability);

    updateWeaponStatus(weapon);

    return { cost, restoredAmount: amount, newStatus: weapon.status, condemned: isCondemned(weapon) };
}

/**
 * How many more shop repairs a weapon has in it before the wear condemns it.
 *
 * Simulated against the real `applyRepair` rather than derived algebraically, so
 * it cannot drift from the mechanic: the degradation step, its floor and the
 * condemnation threshold are all read from the same code the shop runs.
 * `weapon` is not touched — the walk happens on a copy.
 */
function repairsRemaining(weapon) {
    if (!weapon?.baseDurability || !WEAPON_BY_TIER[weapon.tier]) return 0;
    if (isCondemned(weapon)) return 0;

    const sim = {
        tier:             weapon.tier,
        baseDurability:   weapon.baseDurability,
        maxDurability:    weapon.maxDurability,
        currentDurability: 0,
        repairCount:      weapon.repairCount ?? 0,
        status:           'broken',
    };

    let count = 0;
    // The loop is bounded by the degradation step, but a weapon whose base
    // durability is small enough to floor that step to zero would never
    // condemn; cap it rather than spin.
    while (count < 100) {
        const result = applyRepair(sim, sim.maxDurability);
        if (result.error) break;
        count += 1;
        if (result.condemned) break;
        sim.currentDurability = 0;
    }
    return count;
}

/**
 * The whole service life of a fresh weapon of this tier, in coins (#747).
 *
 * A weapon is a consumable: every shop repair permanently drops maxDurability
 * by 10% of base, so the sticker price is only the down payment. Running the
 * full cycle out gives the number that actually decides whether a tier is worth
 * buying — a T12 Altair Rifle costs 20M and then another 35M to keep in the
 * field, which is the part the shop used to leave unsaid.
 *
 * Returns { repairs, maintenance, lifetimeCost, firstRepairCost }.
 */
function projectWeaponLifetime(weaponData) {
    const sim = {
        tier:             weaponData.tier,
        baseDurability:   weaponData.baseDurability,
        maxDurability:    weaponData.baseDurability,
        currentDurability: 0,
        repairCount:      0,
        status:           'broken',
    };

    let repairs = 0, maintenance = 0, firstRepairCost = 0;
    while (repairs < 100) {
        const result = applyRepair(sim, sim.maxDurability);
        if (result.error) break;
        repairs     += 1;
        maintenance += result.cost;
        if (repairs === 1) firstRepairCost = result.cost;
        if (result.condemned) break;
        sim.currentDurability = 0;
    }

    return {
        repairs,
        maintenance,
        lifetimeCost: weaponData.cost + maintenance,
        firstRepairCost,
    };
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
        // Tonic count tracks the same rolling window as the rest of the daily
        // counters (h.dailyWindowStart), so it can't desync from applyDailyReset.
        if (!h.lastTonicDayReset || (h.dailyWindowStart && h.lastTonicDayReset.getTime() < h.dailyWindowStart.getTime())) {
            h.staminaTonicsToday = 0;
            h.lastTonicDayReset  = h.dailyWindowStart ? new Date(h.dailyWindowStart.getTime()) : new Date();
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
        // Repair kit used from hunt shop use — handled in repair command
        return { success: false, error: `Use repair kits with \`/hunt shop repair\`.` };
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

// ─── BEST PAYOUT ─────────────────────────────────────────────────────────────

/**
 * Raises h.bestPayout when beaten, and remembers what the record hunt actually
 * was. The number alone has always been kept; the context (which animal, what
 * tier, where) is what /hunt records needs to make the board worth reading.
 * Older records that predate this carry no meta and render as the bare amount.
 */
function recordBestPayout(h, amount, { animal, tier, zoneId } = {}) {
    if (!(amount > (h.bestPayout ?? 0))) return false;
    h.bestPayout = amount;
    h.bestPayoutMeta = {
        animalName:  animal?.name  ?? null,
        animalEmoji: animal?.emoji ?? null,
        tier:        tier          ?? null,
        zoneId:      zoneId        ?? null,
        at:          new Date(),
    };
    return true;
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
 *   payoutBeforeMods?: number,
 *   finalPayout?: number,
 *   isCrit?: boolean,
 *   critMultiplier?: number,
 *   trophyQuality?: { id, label, emoji, multiplier },
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
function executeHunt(user, zoneId, options = {}) {
    const h      = user.hunt;
    const zone   = ZONES[zoneId ?? h.activeZone];
    const weapon = h.weapons[h.equippedWeaponIndex];

    if (!zone || !weapon) {
        return {
            success: false, xpEarned: 0, durabilityLost: 0, weaponBroke: false,
            failure: { severity: { id: 'error', durLoss: 0, injuryMs: 0, xp: 0 }, message: 'Invalid hunt state.' }
        };
    }

    // The encounter is normally pre-rolled by the caller (rollHuntEncounter)
    // before the approach prompt, so the prompt describes the real animal. The
    // internal roll remains for callers that skip the prompt entirely.
    let tier, animal;
    if (options.encounter?.animal) {
        ({ tier, animal } = options.encounter);
    } else {
        tier = rollTier(user, zone);
        // Stealth bonus: patient approach upgrades common prey to uncommon ~30% of
        // the time. Pre-rolled encounters apply this upgrade caller-side, after the
        // stealth outcome is known.
        if (options.stealthBonus > 0 && tier === 'common' && Math.random() < 0.30) tier = 'uncommon';
        animal = rollAnimal(tier, zoneId ?? h.activeZone);
    }
    const traits = animal.traits ?? [];

    // Base success chance + trait adjustments
    let successChance = calculateSuccessChance(user, weapon, zone);
    if (traits.includes('elusive'))  successChance -= 0.10;
    if (traits.includes('spectral') && h.activeCharm === 'luck_charm') successChance -= 0.015;
    if (options.stealthBonus)        successChance += options.stealthBonus;
    successChance = Math.min(0.95, Math.max(0.10, successChance));

    const success = Math.random() < successChance;

    // Track which consumables were active BEFORE ticking
    const baitBefore  = h.activeBait;
    const charmBefore = h.activeCharm;

    // Insulated Kit shaves a point off every durability hit, win or lose.
    const insulation = h.insulatedKit ? 1 : 0;

    const result = {
        success,
        animal,
        tier,
        traits,
        xpEarned: 0,
        durabilityLost: 0,
        weaponBroke: false,
        traitEffects: []
    };

    if (success) {
        const rawPayout = randInt(animal.payoutMin, animal.payoutMax);

        // Crit — armored trait negates crits; the aim phase moves crit chance.
        const critChance = applyAimBonus(calculateCritChance(user, traits), options.aimBonus);
        const isCrit         = traits.includes('armored') ? false : Math.random() < critChance;
        const critMultiplier = isCrit ? (1.5 + Math.random() * 1.0) : 1.0;

        if (traits.includes('armored')) {
            result.traitEffects.push({ trait: 'armored', msg: 'Its thick hide prevented a critical strike.' });
        }

        // Trophy quality — rolled after crit so crit improves quality odds
        const trophyQuality = rollTrophyQuality(user, weapon, isCrit);

        const streakMult = getStreakMultiplier(user.streak?.current ?? 0);
        let payoutBeforeMods = Math.round(rawPayout * critMultiplier * streakMult * trophyQuality.multiplier);

        // Trait: enraged — +25% payout
        if (traits.includes('enraged')) {
            payoutBeforeMods = Math.round(payoutBeforeMods * 1.25);
            result.traitEffects.push({ trait: 'enraged', msg: 'Its fury drove the prize higher (+25% payout).' });
        }

        const { adjustedPayout, cappedByHard, gatheringYield, forfeitedPayout, dailyReport } = applyPayoutModifiers(user, payoutBeforeMods, zone);

        // Special drop
        let specialDrop = null;
        const huntDropChance = (isCrit ? animal.specialDrop?.chance * 2 : animal.specialDrop?.chance ?? 0) * (options.marketplaceActive ? 1.10 : 1.0);
        if (animal.specialDrop && Math.random() < huntDropChance) {
            specialDrop = animal.specialDrop;
            const matKey = animal.specialDrop.itemId;
            if (h.materials[matKey] != null) {
                h.materials[matKey] += 1;
            } else {
                h.materials[matKey] = 1;
            }
        }

        // XP
        let xpGain = animal.xp;
        if (isCrit) xpGain = Math.round(xpGain * 1.5);
        if (h.activeXpScroll) xpGain = Math.round(xpGain * 1.5);
        xpGain = Math.round(xpGain * streakMult);

        // Durability loss on success (base 1 + giant trait)
        let durLoss = 1;
        if (traits.includes('giant')) {
            durLoss += 1;
            result.traitEffects.push({ trait: 'giant', msg: 'The sheer mass of the beast wore your weapon harder.' });
        }
        applyDurabilityLoss(weapon, durLoss, insulation);
        result.durabilityLost = durLoss;

        // Trait: venomous — costs an extra stamina, unless warded
        if (traits.includes('venomous')) {
            if (h.venomWard) {
                result.traitEffects.push({ trait: 'venomous', msg: '🦂 Your Venom Ward neutralised the toxin — no stamina lost.' });
            } else {
                h.stamina = Math.max(0, h.stamina - 1);
                result.traitEffects.push({ trait: 'venomous', msg: 'Its venom sapped your strength (-1 extra stamina).' });
            }
        }

        // Trait: aggressive — 30% chance to injure even on success, halved by the
        // Swampwalker's Charm
        const injuryChance = h.swampwalkersCharm ? 0.15 : 0.30;
        if (traits.includes('aggressive') && Math.random() < injuryChance) {
            h.injuryUntil = new Date(Date.now() + LIMITS.INJURY_PENALTY_MS);
            result.traitEffects.push({ trait: 'aggressive', msg: 'It lashed out while falling, injuring you (+15 min cooldown).' });
        }

        // Apply payout
        user.balance         += adjustedPayout;
        h.totalEarned        += adjustedPayout;
        h.dailyCoins         += adjustedPayout;
        recordBestPayout(h, adjustedPayout, { animal, tier, zoneId: zone.id });

        // Statistics
        h.successfulHunts    += 1;
        h.consecutiveFails    = 0;
        if (tier === 'legendary') h.legendaryKills += 1;
        if (tier === 'event')     h.eventKills     += 1;

        // Store notable trophies (Good or better) in the collection
        if (trophyQuality.id !== 'poor' && trophyQuality.id !== 'normal') {
            if (!Array.isArray(h.trophies)) h.trophies = [];
            const trophyName = `${trophyQuality.emoji} ${trophyQuality.label} ${animal.name}`;
            if (!h.trophies.includes(trophyName)) {
                h.trophies.push(trophyName);
            }
        }

        // XP & level
        const lvResult = applyXp(user, xpGain);

        Object.assign(result, {
            rawPayout, payoutBeforeMods, finalPayout: adjustedPayout,
            isCrit, critMultiplier: parseFloat(critMultiplier.toFixed(2)),
            trophyQuality,
            specialDrop, xpEarned: xpGain,
            levelUp: lvResult.leveledUp ? lvResult : null,
            cappedByHard,
            forfeitedPayout,
            dailyReport,
            gatheringYield,
            streakMult
        });

        if (weapon.currentDurability <= 0) result.weaponBroke = true;

        // ── Apex encounter check ────────────────────────────────────────
        // 12% chance for legendary, 8% for epic, 3% for rare, skipped for others
        const apexTierChance = tier === 'legendary' ? 0.12 : tier === 'epic' ? 0.08 : tier === 'rare' ? 0.03 : 0;
        if (apexTierChance > 0 && Math.random() < apexTierChance) {
            // The kill's own earned payout rides along so the duel can price
            // itself off the kill rather than re-rolling the base range (#744).
            result.apexEncounter = { animal, tier, killPayout: payoutBeforeMods };
            // Bonus payout handled when the player responds to the encounter
        }

    } else {
        // ── Failure path ────────────────────────────────────────────────
        const severity = rollFailureSeverity();

        // Trait: pack_hunter — extra durability damage on failure
        let failDurLoss = severity.durLoss;
        if (traits.includes('pack_hunter')) {
            if (h.swampwalkersCharm) {
                result.traitEffects.push({ trait: 'pack_hunter', msg: "🐊 The pack circled but kept its distance — your Swampwalker's Charm held them off." });
            } else {
                failDurLoss += 3;
                result.traitEffects.push({ trait: 'pack_hunter', msg: 'The pack descended on you, battering your weapon.' });
            }
        }
        applyDurabilityLoss(weapon, failDurLoss, insulation);
        result.durabilityLost = failDurLoss;

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

        // ── Death event (dangerous zones, 8% of failures, weapon still intact) ──
        if (DANGEROUS_ZONE_IDS.has(zone.id) && !result.weaponBroke && Math.random() < HUNT_DEATH_RATE) {
            if (hasEffect(user, 'lifesaver')) {
                consumeEffect(user, 'lifesaver');
                result.deathEvent = { saved: true, weaponName: weapon.name };
            } else {
                weapon.currentDurability = 0;
                weapon.status = 'broken';
                result.weaponBroke = true;
                result.deathEvent = { saved: false, weaponName: weapon.name };
            }
        }
    }

    // ── Common post-hunt updates ────────────────────────────────────────
    // A clean miss costs time and weapon wear but no stamina: a dry run should
    // burn your afternoon, not your ability to keep playing. Every other outcome
    // — including the harsher failure tiers — still costs a point.
    const staminaSpared = !success && result.failure?.severity?.id === 'clean_miss';
    result.staminaSpared = staminaSpared;

    h.totalHunts  += 1;
    h.dailyHunts  += 1;
    // Clamped: venomous prey already docks a point above, so a hunter who started
    // the hunt with exactly 1 would otherwise land on -1 — which /hunt profile
    // turns into a RangeError building the stamina bar.
    if (!staminaSpared) h.stamina = Math.max(0, h.stamina - 1);
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

// ─── APEX ENCOUNTER RESOLUTION ───────────────────────────────────────────────

const APEX_PHASES_PER_DUEL = 3;

/**
 * One duel's worth of phases: a random draw of APEX_PHASES_PER_DUEL from the
 * apex's phase pool, in a random order. Every phase carries its own correct
 * answer with the tell in its hint, so recognising the apex no longer hands
 * over the whole duel — the sequence isn't memorisable either, because it
 * differs encounter to encounter.
 */
function buildApexEncounter(base) {
    const pool = [...base.phasePool];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return { ...base, phases: pool.slice(0, APEX_PHASES_PER_DUEL) };
}

function rollApexType() {
    const keys = Object.keys(APEX_TYPES);
    return buildApexEncounter(APEX_TYPES[keys[Math.floor(Math.random() * keys.length)]]);
}

// Nerve: the duel's second axis. A wrong aggressive read costs two, so two bad
// guesses end the fight outright even if the third phase lands — which is what
// makes the 'safe' option a real hedge rather than a slower way to lose. At one
// nerve per wrong guess the bar could never reach 0 without also leaving zero
// correct phases, so it decided nothing and the hunter watched a health bar that
// was pure decoration.
const APEX_NERVE_MAX  = 3;
const APEX_NERVE_COST = 2;

/**
 * How much nerve a hunter brings to a duel. The Apex Predator's Mark is worth a
 * whole extra misread — granting a single point would round away to nothing,
 * since nerve is only ever spent two at a time.
 */
function apexNerveMax(user) {
    return APEX_NERVE_MAX + (user?.hunt?.apexPredatorsMark ? APEX_NERVE_COST : 0);
}

/** Nerve left after the given phase results. */
function apexNerveAfter(phaseResults, user) {
    const misreads = phaseResults.filter(p => !p.correct && p.chosen !== 'safe').length;
    return Math.max(0, apexNerveMax(user) - misreads * APEX_NERVE_COST);
}

/**
 * Resolve the played phases. 'safe' never costs nerve; a wrong aggressive
 * choice does. Returns { phaseResults, nerve } — at 0 nerve you lose the duel.
 */
function resolveApexPhases(apexType, choicesMade, user) {
    const phaseResults = [];
    for (let i = 0; i < choicesMade.length; i++) {
        const phase   = apexType.phases[i];
        const chosen  = choicesMade[i];
        const correct = chosen === phase.correct;
        phaseResults.push({ correct, chosen, correctChoice: phase.correct });
    }
    return { phaseResults, nerve: apexNerveAfter(phaseResults, user) };
}

/** What each apex outcome is worth, as a share of the kill it grew out of. */
const APEX_OUTCOME_RATE = { escaped: 0, survived: 0.4, win: 1.0, perfect: 1.5 };

/**
 * The number an apex bonus is a share of (#744).
 *
 * The duel is the climax of a specific kill, so it prices off that kill's own
 * earned payout — crit, trophy quality, streak and the enraged trait included —
 * rather than re-rolling the animal's base range and throwing every multiplier
 * away. Re-rolling also made two identical duels on identical kills pay
 * differently for no reason a player could see.
 *
 * `killPayout` is `payoutBeforeMods` from the hunt that spawned the encounter:
 * post-multiplier but pre-cap, because the apex path runs the payout through
 * `applyPayoutModifiers` itself. Callers that have no kill to point at (the
 * duel primitive under test, a future standalone encounter) fall back to the
 * base range so the function stays callable on its own.
 */
function apexBasePayout(animal, killPayout) {
    const fromKill = Number(killPayout);
    if (Number.isFinite(fromKill) && fromKill > 0) return fromKill;
    return randInt(animal.payoutMin, animal.payoutMax);
}

/**
 * Resolve the final apex outcome after all phases.
 *
 * `options.killPayout` scales the bonus off the kill that spawned the duel; see
 * apexBasePayout.
 *
 * Returns { outcome, bonusPayout, durabilityLost, correctCount, phaseResults, apexType, message }
 */
function resolveApexEncounter(user, animal, tier, choicesMade, apexType, weaponIndex, options = {}) {
    const idx    = weaponIndex ?? user.hunt.equippedWeaponIndex;
    const weapon = user.hunt?.weapons[idx];
    const at     = apexType ?? rollApexType();
    const { phaseResults, nerve } = resolveApexPhases(at, choicesMade, user);

    const correctCount = phaseResults.filter(p => p.correct).length;
    const broken       = nerve <= 0;

    // One roll for the whole duel: the outcome tier picks a share of it, so the
    // four outcomes stay ordered against each other on any single encounter.
    const basePayout = apexBasePayout(animal, options.killPayout);

    let bonusPayout = 0, durabilityLost = 0, outcome = '';

    if (broken || correctCount === 0) {
        outcome = 'escaped';
        if (weapon) { applyDurabilityLoss(weapon, 4); durabilityLost = 4; }
    } else if (correctCount === 1) {
        outcome = 'survived';
        bonusPayout = Math.round(basePayout * APEX_OUTCOME_RATE.survived);
        if (weapon) { applyDurabilityLoss(weapon, 3); durabilityLost = 3; }
    } else if (correctCount === 2) {
        outcome = 'win';
        bonusPayout = Math.round(basePayout * APEX_OUTCOME_RATE.win);
        if (weapon) { applyDurabilityLoss(weapon, 2); durabilityLost = 2; }
    } else {
        outcome = 'perfect';
        bonusPayout = Math.round(basePayout * APEX_OUTCOME_RATE.perfect);
        if (weapon) { applyDurabilityLoss(weapon, 1); durabilityLost = 1; }
    }

    const messages = {
        perfect:  `🏆 **FLAWLESS** — You read the ${at.name} like a book. Maximum trophy!`,
        win:      `✅ You outmaneuvered the ${at.name}. A worthy trophy.`,
        survived: `😓 You barely walked away — the ${at.name} left its mark. Partial reward.`,
        escaped:  `💀 The ${at.name} broke your nerve and vanished into the wild!`
    };

    if (weapon) user.markModified('hunt');
    return { outcome, bonusPayout, durabilityLost, correctCount, phaseResults, apexType: at, message: messages[outcome] };
}

// ─── HUNT TRANSACTION LAYER (#613) ───────────────────────────────────────────
//
// The pieces of a /hunt start that are business logic rather than Discord
// transport: session preparation, preflight validation, the atomic cooldown
// claim, the post-roll bonus stack, and the commit. Same seams as the cast
// transaction layer in fishService.

/**
 * Bring a freshly loaded User document up to date for a hunt. `quickHunt`
 * (a parsed option, or null when omitted) flips the stored quick-hunt
 * preference before the pre-check save so the choice sticks even when this
 * hunt then bounces off a cooldown or stamina gate. Returns the effective
 * quick-hunt flag for this run.
 */
async function prepareHuntUser(user, { quickHunt = null } = {}) {
    const { attachGrind } = require('../utils/grindProfile');
    await attachGrind(user);
    ensureHuntData(user);
    applyStaminaRegen(user);
    applyDailyReset(user);
    assignDailyHuntQuests(user);
    if (quickHunt !== null && quickHunt !== (user.hunt.quickHunt ?? false)) {
        user.hunt.quickHunt = quickHunt;
        user.markModified('hunt');
    }
    if (user.isModified()) {
        await user.save().catch(e => console.error('[hunt] pre-check save error:', e));
    }
    return quickHunt ?? user.hunt.quickHunt ?? false;
}

/**
 * Read-only preflight for a hunt. Returns { ok: true, zoneId, zone, weapon,
 * weaponData } or { ok: false, reason, ... } where `reason` is one of:
 * unknown_zone, zone_locked, level_too_low, injured, cooldown, no_stamina,
 * no_weapon, weapon_broken, no_ammo.
 */
function validateHuntPreflight(user, requestedZoneId) {
    const h = user.hunt;
    const zoneId = requestedZoneId ?? h.activeZone;
    const zone = ZONES[zoneId];

    if (!zone) return { ok: false, reason: 'unknown_zone', zoneId };
    if (!h.unlockedZones.includes(zoneId)) return { ok: false, reason: 'zone_locked', zone };
    if (h.level < zone.unlockLevel) return { ok: false, reason: 'level_too_low', zone };

    if (h.injuryUntil && Date.now() < h.injuryUntil.getTime()) {
        return { ok: false, reason: 'injured', remainingMs: h.injuryUntil.getTime() - Date.now() };
    }

    // Read-only cooldown check; the slot is claimed atomically afterwards.
    if (h.lastHunt && Date.now() - h.lastHunt.getTime() < LIMITS.HUNT_COOLDOWN_MS) {
        return { ok: false, reason: 'cooldown', nextAt: new Date(h.lastHunt.getTime() + LIMITS.HUNT_COOLDOWN_MS) };
    }

    if (h.stamina <= 0) {
        return {
            ok: false,
            reason: 'no_stamina',
            nextAt: new Date(Date.now() + msUntilNextStamina(user)),
            sinceRare: h.sinceRare ?? 0,
            pityCap: getRarePityThreshold(zone),
            maxStamina: getMaxStamina(user),
            zone,
        };
    }

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) return { ok: false, reason: 'no_weapon' };
    const weapon = h.weapons[h.equippedWeaponIndex];
    if (weapon.status === 'broken' || weapon.currentDurability <= 0) {
        return { ok: false, reason: 'weapon_broken', weapon, condemned: isCondemned(weapon) };
    }

    // Read-only ammo check; the round is spent only after the claim wins.
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    if (weaponData.requiresAmmo && (h.ammo[weaponData.ammoType] ?? 0) <= 0) {
        return { ok: false, reason: 'no_ammo', weapon, weaponData };
    }

    return { ok: true, zoneId, zone, weapon, weaponData };
}

/**
 * Atomically claim the hunt cooldown slot now that preflight has passed —
 * lastHunt is set the moment the hunt is actually accepted, not earlier, so a
 * failed precheck (stamina/weapon/ammo) never burns the cooldown. The same
 * guard prevents two concurrent /hunt start calls from both slipping through.
 *
 * The claim targets GrindProfile, not User: hunt state lives in its own
 * collection (see src/models/User.js), so a User-level guard would match
 * every document on the missing `hunt` field and never reject anything.
 *
 * Returns { claimed: true, claimNow, release } or { claimed: false, nextAt }.
 */
async function claimHuntCooldown(user) {
    const GrindProfile = require('../models/GrindProfile');
    const { persistGrindIfNew } = require('../utils/grindProfile');

    const h = user.hunt;
    const claimNow = new Date();
    const cooldownFloor = new Date(claimNow.getTime() - LIMITS.HUNT_COOLDOWN_MS);
    const priorLastHunt = h.lastHunt ?? null;

    await persistGrindIfNew(user, 'hunt');
    const claimQuery = { userId: user.userId, guildId: user.guildId, system: 'hunt' };
    const claimed = await GrindProfile.findOneAndUpdate(
        {
            ...claimQuery,
            $or: [{ 'data.lastHunt': null }, { 'data.lastHunt': { $lte: cooldownFloor } }],
        },
        { $set: { 'data.lastHunt': claimNow } },
        { new: true },
    );

    if (!claimed) {
        // Losing the claim means another hunt already took the slot, so the
        // in-memory snapshot is stale — read the winning timestamp back so the
        // countdown reflects the hunt that actually happened.
        const current = await GrindProfile.findOne(claimQuery).catch(() => null);
        const lastAt = current?.data?.lastHunt ?? claimNow;
        return { claimed: false, nextAt: new Date(new Date(lastAt).getTime() + LIMITS.HUNT_COOLDOWN_MS) };
    }

    h.lastHunt = claimNow;
    const release = () => GrindProfile.updateOne(
        { ...claimQuery, 'data.lastHunt': claimNow },
        { $set: { 'data.lastHunt': priorLastHunt } },
    ).catch(() => null);

    return { claimed: true, claimNow, release };
}

const WILDERNESS_YIELD_BONUS = 0.10;

/**
 * The post-roll bonus stack: pity counter, pet coin yield, pet XP (folded
 * into any level-up the base XP already produced), featured-zone and
 * Wilderness district bonuses (all coin bonuses clamped to the daily hard
 * cap), and the best-payout record. Mutates the user and annotates the
 * result with petYieldBonus / petXpBonus / featuredZoneBonus /
 * wildernessBonus for the renderer.
 */
function applyHuntBonuses(user, result, zoneId, { petYieldPct = 0, petXpPct = 0, isFeaturedZone = false, featuredPayoutBonus = 0, wildernessActive = false } = {}) {
    const h = user.hunt;

    // Pity counter: reset on rare+ success, increment otherwise
    if (result.success && ['rare', 'epic', 'legendary', 'event'].includes(result.tier)) {
        h.sinceRare = 0;
    } else {
        h.sinceRare = (h.sinceRare ?? 0) + 1;
    }

    if (result.success && result.finalPayout > 0 && petYieldPct > 0) {
        const remaining = Math.max(0, LIMITS.DAILY_HARD_CAP - h.dailyCoins);
        const bonus = Math.min(Math.round(result.finalPayout * petYieldPct / 100), remaining);
        if (bonus > 0) {
            user.balance        += bonus;
            h.totalEarned       += bonus;
            h.dailyCoins        += bonus;
            result.finalPayout  += bonus;
            result.petYieldBonus = bonus;
        }
    }
    if (result.success && result.xpEarned > 0 && petXpPct > 0) {
        const xpBonus = Math.round(result.xpEarned * petXpPct / 100);
        if (xpBonus > 0) {
            const petLevelUp = applyXp(user, xpBonus);
            result.xpEarned  += xpBonus;
            result.petXpBonus = xpBonus;
            if (petLevelUp.leveledUp) {
                // Fold into any level-up the base XP already produced so the
                // embed reports one old → new span rather than two.
                result.levelUp = {
                    oldLevel:  result.levelUp?.oldLevel ?? petLevelUp.oldLevel,
                    newLevel:  petLevelUp.newLevel,
                    leveledUp: true,
                };
            }
        }
    }

    if (result.success && result.finalPayout > 0 && isFeaturedZone) {
        const remaining = Math.max(0, LIMITS.DAILY_HARD_CAP - h.dailyCoins);
        const featBonus = Math.min(Math.round(result.finalPayout * featuredPayoutBonus), remaining);
        if (featBonus > 0) {
            user.balance            += featBonus;
            h.totalEarned           += featBonus;
            h.dailyCoins            += featBonus;
            result.finalPayout      += featBonus;
            result.featuredZoneBonus = featBonus;
        }
    }

    if (result.success && result.finalPayout > 0 && wildernessActive) {
        const remaining = LIMITS.DAILY_HARD_CAP - h.dailyCoins;
        const rawBonus  = Math.round(result.finalPayout * WILDERNESS_YIELD_BONUS);
        const bonus     = Math.max(0, Math.min(rawBonus, remaining));
        if (bonus > 0) {
            user.balance          += bonus;
            h.totalEarned         += bonus;
            h.dailyCoins          += bonus;
            result.finalPayout    += bonus;
            result.wildernessBonus = bonus;
        }
    }

    if (result.success) {
        recordBestPayout(h, result.finalPayout, { animal: result.animal, tier: result.tier, zoneId });
    }
}

/**
 * Persist the hunt and credit its coin movement as an atomic `$inc` after the
 * save has landed — same contract as fishService.commitCast. A credit that
 * will not land is returned as `payoutOwed`.
 */
async function commitHunt(user, balanceAtLoad) {
    const User = require('../models/User');
    const { detachBalanceDelta, commitBalanceDelta } = require('../utils/balanceDelta');
    const balanceFilter = { userId: user.userId, guildId: user.guildId };

    const balanceDelta = detachBalanceDelta(user, balanceAtLoad);
    await user.save();
    const payout = await commitBalanceDelta(User, balanceFilter, user, balanceDelta, {
        service: 'hunt',
        jobName: 'huntPayout',
        guildId: user.guildId,
    });
    return { payoutOwed: payout.credited ? 0 : balanceDelta };
}

module.exports = {
    ensureHuntData,
    getMaxStamina,
    applyStaminaRegen,
    msUntilNextStamina,
    applyDailyReset,
    msUntilDailyReset,
    calculateSuccessChance,
    calculateCritChance,
    applyAimBonus,
    rollTier,
    rollAnimal,
    rollHuntEncounter,
    getRarePityThreshold,
    rollFailureSeverity,
    applyPayoutModifiers,
    getDiminishingReturns,
    recordBestPayout,
    applyDurabilityLoss,
    updateWeaponStatus,
    isCondemned,
    repairsRemaining,
    projectWeaponLifetime,
    quoteRepair,
    applyRepair,
    levelFromXp,
    getLevelData,
    xpToNextLevel,
    applyXp,
    activateConsumable,
    tickConsumables,
    rollTrophyQuality,
    executeHunt,
    rollApexType,
    buildApexEncounter,
    APEX_PHASES_PER_DUEL,
    resolveApexEncounter,
    apexBasePayout,
    APEX_OUTCOME_RATE,
    apexNerveAfter,
    apexNerveMax,
    APEX_NERVE_MAX,
    FIELD_TROPHY_FLAGS,
    assignDailyHuntQuests,
    updateHuntQuestProgress,
    prepareHuntUser,
    validateHuntPreflight,
    claimHuntCooldown,
    applyHuntBonuses,
    commitHunt,
    WILDERNESS_YIELD_BONUS,
    formatMs,
    weaponStatusEmoji,
    durabilityBar
};
