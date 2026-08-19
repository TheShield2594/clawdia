'use strict';

const {
    LIMITS,
    EXPLORER_LEVELS,
    EVENT_XP,
    TREASURE_TIERS,
    REGIONS,
    REGION_LIST,
    RELIC_INDEX,
    QUIET_LINES,
} = require('../data/exploreData');

// ─── INIT ────────────────────────────────────────────────────────────────────

const EXPLORE_COUNTERS = [
    'xp', 'totalExpeditions', 'treasuresFound', 'trapsSprung', 'encountersWon',
    'secretsFound', 'loreCollected', 'landmarksDiscovered', 'relicsRecovered',
    'totalEarned', 'bestHaul', 'sinceSecret', 'regionsSurveyed',
    'dailyCoins', 'dailyExpeditions',
];

// Timestamps that legitimately sit at null until something happens
const EXPLORE_TIMESTAMPS = ['staminaLastRegen', 'lastExplore', 'injuryUntil', 'dailyWindowStart'];

/**
 * Backfill the exploration profile. Reports whether it actually wrote anything,
 * so callers can skip a pointless round trip on the overwhelmingly common path
 * where the profile is already complete.
 *
 * @returns {boolean} true if any field was seeded
 */
function ensureExploreData(user) {
    let dirty = false;
    if (!user.exploration) { user.exploration = {}; dirty = true; }
    const e = user.exploration;

    const seed = (key, value) => {
        if (e[key] == null) { e[key] = value; dirty = true; }
    };
    const seedArray = key => {
        if (!Array.isArray(e[key])) { e[key] = []; dirty = true; }
    };

    seed('stamina', LIMITS.MAX_STAMINA);
    seed('level', 1);
    seed('activeRegion', 'whispering_forest');
    for (const key of EXPLORE_COUNTERS) seed(key, 0);
    for (const key of EXPLORE_TIMESTAMPS) {
        if (!(key in e)) { e[key] = null; dirty = true; }
    }
    seedArray('unlockedRegions');
    seedArray('regions');
    seedArray('journal');

    if (!e.unlockedRegions.includes('whispering_forest')) {
        e.unlockedRegions.push('whispering_forest');
        dirty = true;
    }

    if (dirty) user.markModified('exploration');
    return dirty;
}

// Per-region progress record (creates one on first visit)
function getRegionProgress(user, regionId, { create = false } = {}) {
    const e = user.exploration;
    let rec = e.regions.find(r => r.regionId === regionId);
    if (!rec && create) {
        e.regions.push({
            regionId,
            discoveredAt: new Date(),
            expeditions: 0,
            landmarksFound: [],
            loreFound: [],
            secretsFound: [],
        });
        rec = e.regions[e.regions.length - 1];
        user.markModified('exploration');
    }
    return rec ?? null;
}

// ─── STAMINA / DAILY WINDOW ──────────────────────────────────────────────────

/** @returns {boolean} true if anything was written */
function applyStaminaRegen(user) {
    const e = user.exploration;
    const max = LIMITS.MAX_STAMINA;

    if (e.stamina >= max) {
        // Sitting at full: keep the regen anchor fresh so the clock starts from
        // roughly the moment stamina is next spent — but only rewrite it once
        // it has actually gone stale, or every read would be a write.
        const stale = !e.staminaLastRegen
            || Date.now() - e.staminaLastRegen.getTime() >= LIMITS.STAMINA_REGEN_MS;
        const overfull = e.stamina > max;
        e.stamina = max;
        if (!stale && !overfull) return false;
        e.staminaLastRegen = new Date();
        user.markModified('exploration');
        return true;
    }
    if (!e.staminaLastRegen) {
        e.staminaLastRegen = new Date();
        user.markModified('exploration');
        return true;
    }
    const elapsed = Date.now() - e.staminaLastRegen.getTime();
    const intervals = Math.floor(elapsed / LIMITS.STAMINA_REGEN_MS);
    if (intervals <= 0) return false;

    e.stamina = Math.min(max, e.stamina + intervals);
    e.staminaLastRegen = new Date(e.staminaLastRegen.getTime() + intervals * LIMITS.STAMINA_REGEN_MS);
    user.markModified('exploration');
    return true;
}

function msUntilNextStamina(user) {
    const e = user.exploration;
    if (e.stamina >= LIMITS.MAX_STAMINA) return 0;
    if (!e.staminaLastRegen) return LIMITS.STAMINA_REGEN_MS;
    const elapsed = Date.now() - e.staminaLastRegen.getTime();
    return Math.max(0, LIMITS.STAMINA_REGEN_MS - (elapsed % LIMITS.STAMINA_REGEN_MS));
}

/** @returns {boolean} true if the window rolled over */
function applyDailyReset(user) {
    const e = user.exploration;
    const now = Date.now();
    if (!e.dailyWindowStart || now - e.dailyWindowStart.getTime() >= LIMITS.DAILY_WINDOW_MS) {
        e.dailyCoins       = 0;
        e.dailyExpeditions = 0;
        e.dailyWindowStart = new Date(now);
        user.markModified('exploration');
        return true;
    }
    return false;
}

// ─── EXPLORER XP / LEVELS ────────────────────────────────────────────────────

function getLevelData(level) {
    return EXPLORER_LEVELS[Math.min(level, EXPLORER_LEVELS.length) - 1] ?? EXPLORER_LEVELS[0];
}

function xpToNextLevel(level, xp) {
    const next = EXPLORER_LEVELS.find(l => l.level === level + 1);
    if (!next) return null; // max level
    return Math.max(0, next.xpRequired - xp);
}

/**
 * Add explorer XP (cumulative), handling multi-level crossings.
 * Returns { leveled, newLevel, newTitle }.
 */
function applyExplorerXp(user, amount) {
    const e = user.exploration;
    e.xp += amount;
    let leveled = false;
    let next = EXPLORER_LEVELS.find(l => l.level === e.level + 1);
    while (next && e.xp >= next.xpRequired) {
        e.level += 1;
        leveled = true;
        next = EXPLORER_LEVELS.find(l => l.level === e.level + 1);
    }
    user.markModified('exploration');
    return { leveled, newLevel: e.level, newTitle: getLevelData(e.level).title };
}

// ─── RNG / UTILS ─────────────────────────────────────────────────────────────

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

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

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ─── REGION AVAILABILITY ─────────────────────────────────────────────────────

/**
 * Returns true if a seasonal region's event is currently running on the guild.
 * Core regions always return true here (gating is unlock-based).
 */
function isRegionInSeason(region, guildSettings) {
    if (!region.seasonalEventId) return true;
    const ev = guildSettings?.activeEvent;
    if (!ev?.type || ev.type !== region.seasonalEventId) return false;
    if (ev.endsAt && new Date(ev.endsAt) <= new Date()) return false;
    return true;
}

function isRegionEnabled(region, guildSettings) {
    const disabled = guildSettings?.exploration?.disabledRegions ?? [];
    return !disabled.includes(region.id);
}

/**
 * Regions a player can currently set out into: unlocked core regions plus
 * any in-season seasonal regions, minus anything an admin switched off.
 */
function getAvailableRegions(user, guildSettings) {
    const e = user.exploration;
    return REGION_LIST.filter(r => {
        if (!isRegionEnabled(r, guildSettings)) return false;
        if (r.seasonalEventId) return isRegionInSeason(r, guildSettings);
        return e.unlockedRegions.includes(r.id) && e.level >= r.unlockLevel;
    });
}

/**
 * The region a bare `/explore go` should actually set out into.
 *
 * activeRegion is sticky, which strands players: travel into a seasonal region,
 * let the event end, and every unqualified `/explore go` bounces off the
 * out-of-season gate until you notice and travel back by hand. Same for a
 * region an admin switches off. When the stored region is no longer usable we
 * fall back to the richest one that is, and report the switch so the command
 * layer can say so out loud.
 *
 * @returns {{ region: object|null, switched: boolean, from: object|null }}
 */
function resolveActiveRegion(user, guildSettings) {
    const e = user.exploration;
    const current = REGIONS[e.activeRegion] ?? null;
    const available = getAvailableRegions(user, guildSettings);

    if (current && available.some(r => r.id === current.id)) {
        return { region: current, switched: false, from: null };
    }

    // Prefer the best-paying core region still open to the player; the starter
    // region is the floor and is only ever gone if an admin disabled it.
    const fallback = available
        .filter(r => !r.seasonalEventId)
        .sort((a, b) => b.payoutMultiplier - a.payoutMultiplier)[0]
        ?? available[0]
        ?? null;

    if (!fallback) return { region: null, switched: false, from: current };

    e.activeRegion = fallback.id;
    user.markModified('exploration');
    return { region: fallback, switched: Boolean(current), from: current };
}

// ─── CHARTING PROGRESS ───────────────────────────────────────────────────────

function hasUnfoundSecrets(region, progress) {
    if (!progress) return region.secrets.length > 0;
    return region.secrets.some(s => !progress.secretsFound.includes(s.id));
}

/** Every landmark, lore fragment and secret in the region accounted for. */
function isRegionFullyCharted(region, progress) {
    if (!progress) return false;
    return progress.landmarksFound.length >= region.landmarks.length
        && progress.loreFound.length     >= region.lore.length
        && progress.secretsFound.length  >= region.secrets.length;
}

// ─── RELIC COLLECTION ────────────────────────────────────────────────────────

/** Distinct relics the player owns, newest data first. */
function getRelicCollection(user) {
    return (user.inventory ?? [])
        .filter(entry => RELIC_INDEX[entry.itemId] && entry.quantity > 0)
        .map(entry => ({ ...RELIC_INDEX[entry.itemId], quantity: entry.quantity }));
}

/**
 * Standing payout bonus from the relic display case: every DISTINCT relic is
 * worth `RELIC_BONUS_PER`, capped at `RELIC_BONUS_MAX`. Duplicates are for
 * trading, not for stacking.
 */
function getRelicBonus(user) {
    const distinct = getRelicCollection(user).length;
    return Math.min(LIMITS.RELIC_BONUS_MAX, distinct * LIMITS.RELIC_BONUS_PER);
}

// ─── EVENT ROLL ──────────────────────────────────────────────────────────────

/**
 * Roll the event type for an expedition into a region.
 * Admin rareEventBonus and the secret pity counter shift weight toward
 * the rarer slots.
 */
/**
 * The region's event table with the admin rareEventBonus knob applied.
 *
 * Shared by the roll and by the odds display: computing it in only one of the
 * two is how a server with rareEventBonus set ends up being quoted a secret
 * chance lower than the one it actually rolls against.
 */
function buildEventWeights(region, guildSettings) {
    const w = { ...region.eventWeights };

    // Admin knob: shift weight from the mundane to secrets + treasure
    const rareBonus = Math.min(0.25, Math.max(0, guildSettings?.exploration?.rareEventBonus ?? 0));
    if (rareBonus > 0) {
        const shift = (w.quiet + w.trap) * rareBonus;
        w.quiet    = Math.max(1, w.quiet - shift * 0.5);
        w.trap     = Math.max(1, w.trap  - shift * 0.5);
        w.treasure += shift * 0.6;
        w.secret   += shift * 0.4;
    }
    return w;
}

function rollEventType(user, region, guildSettings, progress) {
    const w = buildEventWeights(region, guildSettings);
    const secretsLeft = hasUnfoundSecrets(region, progress);

    if (secretsLeft) {
        // Secret pity: long droughts self-correct
        w.secret += getSecretPity(user);
    } else {
        // Nothing left to uncover here. Drop the slot rather than rolling a
        // "secret" that silently degrades into a treasure — the weight spreads
        // across the rest of the table instead of vanishing into a fake.
        delete w.secret;
    }

    const items = Object.entries(w)
        .map(([type, weight]) => ({ type, weight }))
        .filter(i => i.weight > 0);
    return weightedRoll(items).type;
}

/** Bonus weight the current secret drought has earned. */
function getSecretPity(user) {
    return Math.min(
        LIMITS.SECRET_PITY_MAX,
        (user.exploration.sinceSecret ?? 0) * LIMITS.SECRET_PITY_PER_RUN
    );
}

/**
 * Where the player sits on the secret curve for a given region: the base
 * chance, the pity-boosted chance, and whether the region has anything left
 * to find at all. Display-only — the roll itself lives in rollEventType.
 */
function getSecretOdds(user, region, progress, guildSettings = null) {
    if (!hasUnfoundSecrets(region, progress)) {
        return { exhausted: true, sinceSecret: 0, baseChance: 0, chance: 0, pity: 0 };
    }
    // Same table the roll uses, so a server running rareEventBonus is quoted
    // the odds it actually plays against.
    const w = buildEventWeights(region, guildSettings);
    const total = Object.values(w).reduce((s, n) => s + n, 0);
    const pity = getSecretPity(user);
    return {
        exhausted:   false,
        sinceSecret: user.exploration.sinceSecret ?? 0,
        baseChance:  w.secret / total,
        chance:      (w.secret + pity) / (total + pity),
        pity,
    };
}

function rollTreasureTier() {
    return weightedRoll(TREASURE_TIERS.map(t => ({ ...t, weight: t.weight })));
}

// ─── EXECUTE EXPLORE ─────────────────────────────────────────────────────────

/**
 * Run one expedition. Mutates the user document in memory (coins, XP, stats,
 * region progress, inventory relics) but does NOT save it.
 *
 * Encounters are NOT resolved here — they return a pending result so the
 * command layer can offer the approach/observe choice, then call
 * resolveEncounter() with the player's decision.
 *
 * @param {object} user           - Mongoose user doc (ensureExploreData applied)
 * @param {object} region         - region definition from exploreData
 * @param {object} guildSettings  - guild doc (for drop-rate multipliers)
 * @param {object} [opts]         - { coinMultiplier } event coin multiplier
 * @returns {object} result
 */
function executeExplore(user, region, guildSettings, opts = {}) {
    const e = user.exploration;
    const progress = getRegionProgress(user, region.id, { create: true });
    const firstVisit = progress.expeditions === 0;
    const wasFullyCharted = isRegionFullyCharted(region, progress);
    const secretsLeft = hasUnfoundSecrets(region, progress);

    e.stamina -= 1;
    e.lastExplore = new Date();
    e.totalExpeditions += 1;
    e.dailyExpeditions += 1;
    progress.expeditions += 1;

    const coinMult    = getPayoutMultiplier(user, region, guildSettings, opts.coinMultiplier ?? 1, progress);
    const penaltyMult = getPenaltyMultiplier(region);

    const result = {
        regionId: region.id,
        firstVisit,
        secretsLeft,
        surveyed: wasFullyCharted,
        type: rollEventType(user, region, guildSettings, progress),
        payout: 0,
        grossPayout: 0,
        xp: 0,
        intro: randomFrom(region.intros),
        coinMultiplier: opts.coinMultiplier ?? 1,
    };

    switch (result.type) {
        case 'discovery': {
            const unfound = region.landmarks.filter(l => !progress.landmarksFound.includes(l.id));
            if (unfound.length === 0) {
                // Nothing left to chart here — the slot pays out as treasure.
                return finishAsTreasure(user, region, progress, result, coinMult, { fallback: true });
            }
            const landmark = randomFrom(unfound);
            progress.landmarksFound.push(landmark.id);
            e.landmarksDiscovered += 1;
            result.landmark = landmark;
            result.payout = applyPayout(user, result, Math.round(randInt(300, 700) * coinMult));
            result.xp = grantXp(user, EVENT_XP.discovery, result);
            break;
        }

        case 'lore': {
            const unfound = region.lore.filter(l => !progress.loreFound.includes(l.id));
            if (unfound.length === 0) {
                return finishAsTreasure(user, region, progress, result, coinMult, { fallback: true });
            }
            const fragment = randomFrom(unfound);
            progress.loreFound.push(fragment.id);
            e.loreCollected += 1;
            result.lore = fragment;
            result.payout = applyPayout(user, result, Math.round(randInt(150, 400) * coinMult));
            result.xp = grantXp(user, EVENT_XP.lore, result);
            break;
        }

        case 'secret': {
            // rollEventType only offers this slot while a secret is unfound.
            const secret = randomFrom(region.secrets.filter(s => !progress.secretsFound.includes(s.id)));
            progress.secretsFound.push(secret.id);
            e.secretsFound += 1;
            e.sinceSecret = 0;
            result.secret = secret;
            result.payout = applyPayout(user, result, Math.round(secret.reward * coinMult));
            result.xp = grantXp(user, EVENT_XP.secret, result);
            break;
        }

        case 'treasure': {
            return finishAsTreasure(user, region, progress, result, coinMult);
        }

        case 'trap': {
            const trap = randomFrom(region.traps);
            // Trap penalties are hand-tuned per region already, so they take
            // no region multiplier on top — only the balance floor applies.
            const rawPenalty = randInt(trap.penalty.min, trap.penalty.max);
            const penalty = Math.min(rawPenalty, Math.max(0, user.balance));
            user.balance -= penalty;
            e.trapsSprung += 1;
            result.trap = trap;
            result.penalty = penalty;
            result.xp = grantXp(user, EVENT_XP.trap, result);
            if (Math.random() < trap.injuryChance) {
                e.injuryUntil = new Date(Date.now() + LIMITS.INJURY_PENALTY_MS);
                result.injured = true;
            }
            break;
        }

        case 'encounter': {
            // Pending: command layer resolves via resolveEncounter()
            result.encounter = randomFrom(region.encounters);
            result.penaltyMultiplier = penaltyMult;
            result.pendingChoice = true;
            break;
        }

        case 'quiet':
        default: {
            // Nothing found, nothing spent. A blank walk costs the cooldown and
            // the boot leather; it does not also cost a stamina point.
            result.type = 'quiet';
            result.quietLine = randomFrom(QUIET_LINES);
            result.xp = grantXp(user, EVENT_XP.quiet, result);
            e.stamina = Math.min(LIMITS.MAX_STAMINA, e.stamina + 1);
            result.staminaSpared = true;
            break;
        }
    }

    if (result.type !== 'secret' && !result.pendingChoice) {
        countTowardPity(user, result);
    }

    finalizeStats(user, region, progress, result, wasFullyCharted);
    user.markModified('exploration');
    return result;
}

/**
 * The raw coin band a lost encounter costs, before region depth is applied.
 * Priced off the encounter's own average reward — see LIMITS.ENCOUNTER_LOSS_RATE.
 */
function encounterLossBand(enc) {
    const avgReward = (enc.reward.min + enc.reward.max) / 2;
    const base = avgReward * LIMITS.ENCOUNTER_LOSS_RATE;
    return { min: Math.round(base * 0.75), max: Math.round(base * 1.25) };
}

/**
 * What each option in an encounter is actually worth, in the coins this player
 * would see — every multiplier already applied. Display-only: the prompt used to
 * offer a blind choice between two pieces of flavour text, which is not a
 * decision so much as a coin toss with extra reading.
 */
function getEncounterStakes(user, region, guildSettings, result) {
    const enc = result.encounter;
    const progress = getRegionProgress(user, region.id);
    const coinMult    = getPayoutMultiplier(user, region, guildSettings, result.coinMultiplier ?? 1, progress);
    const penaltyMult = getPenaltyMultiplier(region);
    const loss = encounterLossBand(enc);
    const scale = (n, mult) => Math.round(n * mult);
    return {
        winChance: enc.winChance,
        win:  { min: scale(enc.reward.min, coinMult), max: scale(enc.reward.max, coinMult) },
        safe: { min: scale(enc.reward.min, coinMult * LIMITS.ENCOUNTER_SAFE_RATE),
                max: scale(enc.reward.max, coinMult * LIMITS.ENCOUNTER_SAFE_RATE) },
        loss: { min: scale(loss.min, penaltyMult), max: scale(loss.max, penaltyMult) },
    };
}

/**
 * Resolve a pending encounter after the player chose.
 * @param {string} choice - 'approach' | 'observe' | null (timeout = observe)
 */
function resolveEncounter(user, region, guildSettings, result, choice) {
    const e = user.exploration;
    const enc = result.encounter;
    const progress = getRegionProgress(user, region.id);
    const coinMult    = getPayoutMultiplier(user, region, guildSettings, result.coinMultiplier ?? 1, progress);
    const penaltyMult = getPenaltyMultiplier(region);

    result.pendingChoice = false;
    result.choice = choice === 'approach' ? 'approach' : 'observe';

    if (result.choice === 'approach') {
        if (Math.random() < enc.winChance) {
            result.outcome = 'win';
            e.encountersWon += 1;
            result.payout = applyPayout(user, result, Math.round(randInt(enc.reward.min, enc.reward.max) * coinMult));
            result.xp = grantXp(user, EVENT_XP.encounter_win, result);
        } else {
            result.outcome = 'loss';
            // Losses scale with the region and with what was on the table, and
            // deliberately with nothing else. Folding the event coin bonus or the
            // admin drop-rate knob in here would mean a "double coins" weekend
            // also doubled the beating, and a generous admin made failure five
            // times more expensive.
            const band = encounterLossBand(enc);
            const penalty = Math.min(Math.round(randInt(band.min, band.max) * penaltyMult), Math.max(0, user.balance));
            user.balance -= penalty;
            result.penalty = penalty;
            result.xp = grantXp(user, EVENT_XP.encounter_loss, result);
            if (Math.random() < 0.15) {
                e.injuryUntil = new Date(Date.now() + LIMITS.INJURY_PENALTY_MS);
                result.injured = true;
            }
        }
    } else {
        result.outcome = 'safe';
        result.payout = applyPayout(user, result, Math.round(randInt(enc.reward.min, enc.reward.max) * coinMult * LIMITS.ENCOUNTER_SAFE_RATE));
        result.xp = grantXp(user, EVENT_XP.encounter_safe, result);
    }

    countTowardPity(user, result);
    finalizeStats(user, region, progress, result, isRegionFullyCharted(region, progress));
    user.markModified('exploration');
    return result;
}

/**
 * Treasure resolution, also used when a discovery/lore slot has nothing left to
 * give. A fallback roll is capped at `rare` so an exhausted slot can't become
 * the best jackpot in the game — but it keeps its relic chance, because
 * charting a region shouldn't quietly delete its relic drops.
 */
function finishAsTreasure(user, region, progress, result, coinMult, { fallback = false } = {}) {
    const e = user.exploration;
    result.type = 'treasure';
    result.fallbackTreasure = fallback;

    let tier = rollTreasureTier();
    if (fallback && ['epic', 'legendary'].includes(tier.tier)) {
        tier = TREASURE_TIERS.find(t => t.tier === 'rare');
    }
    result.treasureTier = tier;
    result.treasureLine = randomFrom(region.treasureLines);
    result.payout = applyPayout(user, result, Math.round(randInt(tier.min, tier.max) * coinMult));
    result.xp = grantXp(user, EVENT_XP.treasure, result);
    e.treasuresFound += 1;

    // Rare+ treasures may carry a relic into the player's inventory
    if (Math.random() < tier.relicChance) {
        // Every region in the table defines relics today; the fallback is here so
        // a future one added without them degrades to a plain treasure instead of
        // throwing mid-expedition.
        const pool = (region.relics ?? []).filter(r =>
            tier.tier === 'legendary' ? true : r.rarity !== 'legendary'
        );
        if (pool.length) {
            // Prefer relics the player is missing, so a display case actually
            // fills instead of stacking the same charm forever.
            const owned = new Set(getRelicCollection(user).map(r => r.itemId));
            const missing = pool.filter(r => !owned.has(r.itemId));
            const relic = randomFrom(missing.length ? missing : pool);
            addRelicToInventory(user, relic);
            e.relicsRecovered += 1;
            result.relic = relic;
            result.relicIsNew = !owned.has(relic.itemId);
        }
    }

    countTowardPity(user, result);
    finalizeStats(user, region, progress, result, isRegionFullyCharted(region, progress));
    user.markModified('exploration');
    return result;
}

// ─── REWARD HELPERS ──────────────────────────────────────────────────────────

/**
 * Everything that multiplies a payout: the seasonal event bonus, the admin
 * drop-rate knob, how deep the region is, the standing bonus for a fully
 * surveyed map, and the relic display case.
 */
function getPayoutMultiplier(user, region, guildSettings, eventCoinMultiplier = 1, progress = null) {
    const dropRate = clamp(guildSettings?.exploration?.dropRateMultiplier ?? 1, 0.1, 5);
    const survey   = isRegionFullyCharted(region, progress) ? 1 + LIMITS.SURVEY_BONUS : 1;
    const relics   = 1 + getRelicBonus(user);
    return eventCoinMultiplier * dropRate * region.payoutMultiplier * survey * relics;
}

/**
 * What a loss is multiplied by. Deliberately NOT the payout multiplier: a
 * region's depth is a fair reason for a costlier mistake, a coin-bonus weekend
 * and an admin generosity setting are not.
 */
function getPenaltyMultiplier(region) {
    return region.payoutMultiplier;
}

/**
 * Credit coins, respecting the rolling daily caps. Past the soft cap the payout
 * settles at `DAILY_SOFT_CAP_RATE` of face value; past the hard cap it settles
 * at nothing. Records the gross amount and which cap bit, so the embed can say
 * what happened — otherwise a legendary haul renders with a halved coin line, or
 * none at all, and no explanation.
 *
 * `cappedByDailyCap` stays the umbrella "the cap took something" flag it has
 * always been; `softCapped` and `hardCapped` say which one, for callers that
 * need to word it.
 *
 * Returns the amount actually granted.
 */
function applyPayout(user, result, amount) {
    const e = user.exploration;
    const remaining  = Math.max(0, LIMITS.DAILY_HARD_CAP - e.dailyCoins);
    const softCapped = e.dailyCoins >= LIMITS.DAILY_SOFT_CAP;
    // The soft rate applies to the whole payout, not just the part above the
    // line — same settlement hunting and fishing use, and it keeps the rule
    // something a player can state in one sentence.
    const settled = softCapped ? Math.round(amount * LIMITS.DAILY_SOFT_CAP_RATE) : amount;
    const granted = Math.min(settled, remaining);
    if (granted > 0) {
        user.balance       += granted;
        e.totalEarned      += granted;
        e.dailyCoins       += granted;
    }
    if (result) {
        result.grossPayout = (result.grossPayout ?? 0) + amount;
        if (softCapped && amount > 0)  result.softCapped = true;
        if (granted < settled)         result.hardCapped = true;
        if (granted < amount)          result.cappedByDailyCap = true;
    }
    return granted;
}

/**
 * Explorer XP + report the amount so the command layer can mirror it into guild XP.
 *
 * Crossing an explorer level is recorded on `result` rather than dropped on the
 * floor: explorer level is what gates every region unlock, so a player who is
 * never told they levelled has no idea a new region just came within reach. One
 * expedition can grant twice (the event, then the survey bonus) and can cross
 * more than one level, so the record keeps the level they started at and the
 * level they ended on.
 */
function grantXp(user, amount, result = null) {
    const before = user.exploration.level;
    const { leveled, newLevel, newTitle } = applyExplorerXp(user, amount);
    if (leveled && result) {
        result.explorerLevelUp = {
            oldLevel: result.explorerLevelUp?.oldLevel ?? before,
            newLevel,
            newTitle,
        };
    }
    return amount;
}

function addRelicToInventory(user, relic) {
    if (!user.inventory) user.inventory = [];
    const existing = user.inventory.find(i => i.itemId === relic.itemId);
    if (existing) existing.quantity += 1;
    else user.inventory.push({ itemId: relic.itemId, quantity: 1 });
    user.markModified('inventory');
}

/**
 * Advance the secret drought counter — but only for expeditions that could
 * actually have turned up a secret. Counting runs into a fully-uncovered region
 * inflates the number behind a promise the region can no longer keep.
 */
function countTowardPity(user, result) {
    if (!result.secretsLeft) return;
    user.exploration.sinceSecret += 1;
}

function finalizeStats(user, region, progress, result, wasFullyCharted) {
    const e = user.exploration;
    if (result.payout > e.bestHaul) e.bestHaul = result.payout;

    // First time this region has nothing left to hide.
    if (!wasFullyCharted && isRegionFullyCharted(region, progress)) {
        progress.completedAt = new Date();
        result.regionCompleted = true;
        result.surveyBonus = LIMITS.SURVEY_BONUS;
        e.regionsSurveyed = (e.regionsSurveyed ?? 0) + 1;
        result.xp = (result.xp ?? 0) + grantXp(user, EVENT_XP.survey, result);
    }
}

// ─── JOURNAL ─────────────────────────────────────────────────────────────────

function addJournalEntry(user, regionId, eventType, summary) {
    const e = user.exploration;
    e.journal.unshift({ at: new Date(), regionId, eventType, summary });
    if (e.journal.length > LIMITS.JOURNAL_CAP) {
        e.journal.splice(LIMITS.JOURNAL_CAP);
    }
    user.markModified('exploration');
}

// ─── MAP RENDERING ───────────────────────────────────────────────────────────

function regionCompletion(region, progress) {
    const total = region.landmarks.length + region.lore.length + region.secrets.length;
    if (!progress || total === 0) return 0;
    const found = progress.landmarksFound.length + progress.loreFound.length + progress.secretsFound.length;
    return Math.round((found / total) * 100);
}

function chartBar(pct, width = 10) {
    const filled = Math.round((pct / 100) * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/**
 * Render the Explorer's Map as embed-ready text sections.
 * Undiscovered regions appear as redacted entries; seasonal regions only
 * appear if visited at least once or currently in season.
 */
function renderMap(user, guildSettings) {
    const e = user.exploration;
    const lines = [];

    for (const region of REGION_LIST) {
        if (!isRegionEnabled(region, guildSettings)) continue;
        const progress = e.regions.find(r => r.regionId === region.id) ?? null;
        const inSeason = isRegionInSeason(region, guildSettings);

        // Seasonal regions the player has never seen and that aren't running: hidden entirely
        if (region.seasonalEventId && !progress && !inSeason) continue;

        if (!progress) {
            const gate = region.seasonalEventId
                ? 'in season now — go look'
                : e.unlockedRegions.includes(region.id)
                    ? 'unlocked — never entered'
                    : `locked · Explorer Lv ${region.unlockLevel}`;
            lines.push(`🌫️ **??? — uncharted**\n> \`▒▒▒▒▒▒▒▒▒▒\` *${gate}*`);
            continue;
        }

        const pct = regionCompletion(region, progress);
        const seasonalTag = region.seasonalEventId
            ? (inSeason ? ' · *in season*' : ' · *out of season*')
            : '';
        const surveyTag = isRegionFullyCharted(region, progress)
            ? ` · 🏅 *fully surveyed (+${Math.round(LIMITS.SURVEY_BONUS * 100)}% haul)*`
            : '';
        lines.push(
            `${region.emoji} **${region.name}** — ${pct}% charted${seasonalTag}${surveyTag}\n` +
            `> \`${chartBar(pct)}\` ` +
            `🗿 ${progress.landmarksFound.length}/${region.landmarks.length} · ` +
            `📜 ${progress.loreFound.length}/${region.lore.length} · ` +
            `✨ ${progress.secretsFound.length}/${region.secrets.length}`
        );
    }

    return lines;
}

// ─── MISC ────────────────────────────────────────────────────────────────────

function formatMs(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

module.exports = {
    ensureExploreData,
    getRegionProgress,
    applyStaminaRegen,
    msUntilNextStamina,
    applyDailyReset,
    getLevelData,
    xpToNextLevel,
    applyExplorerXp,
    weightedRoll,
    randomFrom,
    isRegionInSeason,
    isRegionEnabled,
    getAvailableRegions,
    resolveActiveRegion,
    hasUnfoundSecrets,
    isRegionFullyCharted,
    getRelicCollection,
    getRelicBonus,
    buildEventWeights,
    getSecretOdds,
    getPayoutMultiplier,
    getPenaltyMultiplier,
    executeExplore,
    resolveEncounter,
    encounterLossBand,
    getEncounterStakes,
    addJournalEntry,
    regionCompletion,
    renderMap,
    formatMs,
    REGIONS,
};
