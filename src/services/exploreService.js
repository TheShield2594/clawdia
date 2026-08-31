'use strict';

const {
    LIMITS,
    EXPLORER_PRESTIGE,
    MAX_EXPLORER_LEVEL,
    MAX_EXPLORER_PRESTIGE,
    PRESTIGE_TITLES,
    EVENT_XP,
    TREASURE_TIERS,
    TREASURE_MATERIALS,
    REGIONS,
    REGION_LIST,
    RELIC_INDEX,
    QUIET_LINES,
} = require('../data/exploreData');
const grind = require('./grindEngine');
const { MATERIAL_RARITY } = require('../data/materialRarity');

// ─── INIT ────────────────────────────────────────────────────────────────────

// Explore's own counters. `xp`, `dailyCoins` and `dailyExpeditions` are the
// engine's and are seeded there, for every grind at once.
const EXPLORE_COUNTERS = [
    'totalExpeditions', 'treasuresFound', 'trapsSprung', 'encountersWon',
    'secretsFound', 'loreCollected', 'landmarksDiscovered', 'relicsRecovered',
    'totalEarned', 'bestHaul', 'sinceSecret', 'regionsSurveyed',
];

// Timestamps that legitimately sit at null until something happens.
// `staminaLastRegen` and `dailyWindowStart` are the engine's, likewise.
const EXPLORE_TIMESTAMPS = ['lastExplore', 'injuryUntil'];

/**
 * Backfill the exploration profile. Reports whether it actually wrote anything,
 * so callers can skip a pointless round trip on the overwhelmingly common path
 * where the profile is already complete.
 *
 * @returns {boolean} true if any field was seeded
 */
function ensureExploreData(user) {
    // Stamina, xp, level, prestige, the daily counters and the material bag are
    // the engine's fields and it seeds them for every grind the same way (#892).
    // What is below is the rest of an explorer profile, which is explore's own.
    let dirty = grind.ensureSharedFields(user, 'explore');
    const e = user.exploration;

    const seed = (key, value) => {
        if (e[key] == null) { e[key] = value; dirty = true; }
    };
    const seedArray = key => {
        if (!Array.isArray(e[key])) { e[key] = []; dirty = true; }
    };

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

/**
 * Max exploration stamina for a user. The other three grind systems each grew a
 * per-user getter when synergies started lifting their caps; exploration's was
 * still the flat constant, which is why no synergy could pay out into it.
 * The Permanent Stamina +1 shop item stays out of this on purpose — it is sold
 * as hunt/fish/mine only.
 */
// The mechanics below — the stamina bank, the rolling daily window, the level
// ladder and the countdown format — are the same in all four grinds and live in
// services/grindEngine.js (#892). What is left here is the `'explore'` in each
// call: which spec the engine should use.
const getMaxStamina = user => grind.getMaxStamina(user, 'explore');

/** @returns {boolean} true if anything was written */
const applyStaminaRegen = user => grind.applyStaminaRegen(user, 'explore');

const msUntilNextStamina = user => grind.msUntilNextStamina(user, 'explore');

/** @returns {boolean} true if the window rolled over */
const applyDailyReset = user => grind.applyDailyReset(user, 'explore');

// ─── EXPLORER XP / LEVELS ────────────────────────────────────────────────────

const getLevelData = level => grind.getLevelData(level, 'explore');

// ─── EXPLORER PRESTIGE ───────────────────────────────────────────────────────

/**
 * The bonus row for a user's prestige rank, clamped to the table (#750).
 * Reads a missing rank as 0, so profiles written before the field existed
 * behave exactly as they did.
 */
function getExplorerPrestige(user) {
    const rank = Math.max(0, Number(user?.exploration?.prestige) || 0);
    return EXPLORER_PRESTIGE[Math.min(rank, MAX_EXPLORER_PRESTIGE)];
}

/** Whether this explorer has anything left to ascend into, and what blocks it. */
function canPrestige(user) {
    const e    = user?.exploration ?? {};
    const rank = Math.max(0, Number(e.prestige) || 0);
    if (rank >= MAX_EXPLORER_PRESTIGE) return { ok: false, reason: 'max_rank', rank };
    if ((e.level ?? 1) < MAX_EXPLORER_LEVEL) {
        return { ok: false, reason: 'level_too_low', rank, level: e.level ?? 1 };
    }
    return { ok: true, rank, nextRank: rank + 1 };
}

/**
 * The title an explorer carries. A prestiged wanderer keeps their rank title
 * rather than dropping back to 'Doorstep Wanderer' — resetting the level is the
 * cost of ascending, reading as a beginner afterwards is not.
 */
function getExplorerTitle(user) {
    const rank = Math.max(0, Number(user?.exploration?.prestige) || 0);
    const level = user?.exploration?.level ?? 1;
    // Once the level ladder has been climbed back past its own titles, the
    // level title is the more specific one and wins.
    if (rank > 0 && level < MAX_EXPLORER_LEVEL) {
        return PRESTIGE_TITLES[Math.min(rank, PRESTIGE_TITLES.length - 1)]
            ?? getLevelData(level).title;
    }
    return getLevelData(level).title;
}

const xpToNextLevel = (level, xp) => grind.xpToNextLevel(level, xp, 'explore');

/**
 * Add explorer XP (cumulative), handling multi-level crossings.
 * Returns { leveled, newLevel, newTitle }.
 */
/**
 * Credit explorer xp. The ladder itself is the engine's; the title that comes
 * with the new rank is explore's own, so the return shape stays here.
 */
function applyExplorerXp(user, amount) {
    const { newLevel, leveledUp } = grind.applyXp(user, amount, 'explore');
    // The engine marks the subdocument only when the level moved; the xp itself
    // always did.
    user.markModified('exploration');
    return { leveled: leveledUp, newLevel, newTitle: getLevelData(newLevel).title };
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
    return Math.min(getRelicBonusCap(user), distinct * LIMITS.RELIC_BONUS_PER);
}

/**
 * How wide this explorer's display case is. The base cap pays for ten distinct
 * relics out of twenty-five, which is what made the back half of the collection
 * worth nothing but trade value; each prestige rank widens it, and the top rank
 * opens it far enough that a complete set pays in full (#750).
 */
function getRelicBonusCap(user) {
    return LIMITS.RELIC_BONUS_MAX + getExplorerPrestige(user).relicCapBonus;
}

/** How many distinct relics a case of the given width actually pays for. */
function relicCapacityForBonus(relicCapBonus = 0) {
    return Math.round((LIMITS.RELIC_BONUS_MAX + relicCapBonus) / LIMITS.RELIC_BONUS_PER);
}

/** How many distinct relics this explorer's case has room to pay for. */
function getRelicCapacity(user) {
    return relicCapacityForBonus(getExplorerPrestige(user).relicCapBonus);
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

/**
 * The prestige rank's share of the secret slot, applied as a multiplier on the
 * slot's own weight rather than a flat addition — a flat one would swamp the
 * starter region's table and barely register in a deep one.
 *
 * Applied in both the roll and the odds display, so a prestiged explorer is
 * quoted the chance they actually play against.
 */
function applySecretPrestige(weight, user) {
    return weight * (1 + getExplorerPrestige(user).secretBonus);
}

function rollEventType(user, region, guildSettings, progress) {
    const w = buildEventWeights(region, guildSettings);
    const secretsLeft = hasUnfoundSecrets(region, progress);

    if (secretsLeft) {
        w.secret = applySecretPrestige(w.secret, user);
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
    // Same widening the roll applies, before the total is taken — quoting the
    // unprestiged slot against a prestiged roll is the one thing this must not do.
    w.secret = applySecretPrestige(w.secret, user);
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
            e.stamina = Math.min(getMaxStamina(user), e.stamina + 1);
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
    // Payouts are quoted after the daily caps have taken their cut, because that
    // is what the player will actually be credited. Losses are not: the caps
    // govern what exploration pays out, never what a mistake costs.
    const payout = (n, mult) => settleAgainstDailyCap(user, Math.round(n * mult)).granted;
    const scale  = (n, mult) => Math.round(n * mult);
    // Read the headroom directly rather than probing with a coin: at a soft rate
    // below 0.5, Math.round would settle that coin to nothing and call a player
    // capped while they can still win thousands.
    const capped = settleAgainstDailyCap(user, 0).remaining === 0;
    return {
        winChance: enc.winChance,
        win:  { min: payout(enc.reward.min, coinMult), max: payout(enc.reward.max, coinMult) },
        safe: { min: payout(enc.reward.min, coinMult * LIMITS.ENCOUNTER_SAFE_RATE),
                max: payout(enc.reward.max, coinMult * LIMITS.ENCOUNTER_SAFE_RATE) },
        loss: { min: scale(loss.min, penaltyMult), max: scale(loss.max, penaltyMult) },
        // True once the hard cap leaves nothing to win, so the prompt can say
        // the bet is all downside rather than silently offering a 0-coin prize.
        capped,
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

    // Fieldcraft materials, tier-matched to the treasure (#753). Exploration
    // produced nothing feedable before this, which is the whole reason it had
    // no rare companion.
    result.material = grantTreasureMaterial(user, tier.tier);

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
    const prestige = 1 + getExplorerPrestige(user).payoutBonus;
    return eventCoinMultiplier * dropRate * region.payoutMultiplier * survey * relics * prestige;
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
/**
 * What `amount` is actually worth to this player right now, after the rolling
 * daily caps. Pure — it reads `dailyCoins` and returns, touching nothing.
 *
 * Shared with the encounter prompt on purpose: that prompt exists to quote the
 * coins the player would really see, and quoting a pre-cap figure while the
 * payout settles at half of it is the one thing it must not do.
 */
function settleAgainstDailyCap(user, amount) {
    const e = user.exploration;
    const remaining  = Math.max(0, LIMITS.DAILY_HARD_CAP - e.dailyCoins);
    const softCapped = e.dailyCoins >= LIMITS.DAILY_SOFT_CAP;
    // The soft rate applies to the whole payout, not just the part above the
    // line — same settlement hunting and fishing use, and it keeps the rule
    // something a player can state in one sentence.
    const settled = softCapped ? Math.round(amount * LIMITS.DAILY_SOFT_CAP_RATE) : amount;
    return { granted: Math.min(settled, remaining), settled, softCapped, remaining };
}

function applyPayout(user, result, amount) {
    const e = user.exploration;
    const { granted, settled, softCapped } = settleAgainstDailyCap(user, amount);
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

// The fieldcraft materials a treasure of each tier can drop, resolved once at
// load rather than filtered per expedition. Keyed by material tier.
const EXPLORE_MATERIALS_BY_TIER = Object.entries(MATERIAL_RARITY)
    .filter(([, data]) => data.source === 'explore')
    .reduce((byTier, [id, data]) => {
        (byTier[data.tier] ??= []).push(id);
        return byTier;
    }, {});

/**
 * Roll the fieldcraft material a treasure carries, if any (#753).
 *
 * Pure, and returns the material id or null, so the caller decides what to do
 * with it and a test can drive the roll without a user document.
 *
 * A tier the catalog has no material for is skipped rather than producing an
 * undefined id — that is how a table entry naming a tier nobody wrote materials
 * for would otherwise reach the inventory as a blank row.
 *
 * The tier is drawn first, uniformly among the eligible ones, and only then a
 * material within it. Flattening the tiers into one pool and drawing from that
 * would weight each tier by how many materials happen to be written at it: an
 * uncommon treasure names tiers 1 and 2, and with three tier-1 materials
 * against two tier-2 ones it would land tier 1 six times in ten for no reason
 * anybody chose. Writing a twelfth material would then quietly move the drop
 * rates. TREASURE_MATERIALS is meant to be the only balance lever here, and
 * this is what keeps it the only one.
 */
function rollTreasureMaterial(treasureTier, rng = Math.random) {
    const table = TREASURE_MATERIALS[treasureTier];
    if (!table) return null;
    if (rng() >= table.chance) return null;

    const eligible = table.tiers.filter(tier => (EXPLORE_MATERIALS_BY_TIER[tier] ?? []).length > 0);
    if (!eligible.length) return null;

    const tier = eligible[Math.floor(rng() * eligible.length)] ?? eligible[eligible.length - 1];
    const materials = EXPLORE_MATERIALS_BY_TIER[tier];
    return materials[Math.floor(rng() * materials.length)] ?? null;
}

/**
 * Roll a material for this treasure and add it to the explorer's pile.
 * Returns the granted material's id and catalog entry, or null.
 */
function grantTreasureMaterial(user, treasureTier, rng = Math.random) {
    const id = rollTreasureMaterial(treasureTier, rng);
    if (!id) return null;

    const e = user.exploration;
    if (!e.materials || typeof e.materials !== 'object') e.materials = {};
    e.materials[id] = (e.materials[id] ?? 0) + 1;
    return { id, ...MATERIAL_RARITY[id] };
}

/**
 * Adds the Lantern Owl's Explorer XP passive on top of whatever the expedition
 * already granted (#753).
 *
 * Applied after the fact rather than threaded through the eleven grantXp call
 * sites, which is also what lets it cover XP granted *after* executeExplore
 * returns — the encounter the player is still deciding on, and the survey
 * bonus. Level-ups from the bonus merge into `result.explorerLevelUp` the same
 * way grantXp merges its own, so a level crossed on the bonus alone is still
 * announced.
 *
 * @returns {number} the bonus XP granted, 0 when there was none
 */
function applyExploreXpBonus(user, result, bonusPct) {
    const base = result?.xp ?? 0;
    if (!(bonusPct > 0) || !(base > 0)) return 0;

    const bonus = Math.round(base * (bonusPct / 100));
    if (bonus <= 0) return 0;

    result.petXp = (result.petXp ?? 0) + bonus;
    result.xp = base + grantXp(user, bonus, result);
    return bonus;
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
            // A region whose route you have already paid to open is not a
            // mystery — you know its name, you just haven't walked it. Redacting
            // it turned every unentered region into the same anonymous "???" row.
            const known = region.seasonalEventId ? inSeason : e.unlockedRegions.includes(region.id);
            const gate = region.seasonalEventId
                ? 'in season now — go look'
                : known
                    ? 'route open — never entered'
                    : `locked · Explorer Lv ${region.unlockLevel}`;
            const head = known
                ? `${region.emoji} **${region.name}** — uncharted`
                : '🌫️ **??? — uncharted**';
            lines.push(`${head}\n> \`▒▒▒▒▒▒▒▒▒▒\` *${gate}*`);
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

const formatMs = grind.formatMs;

module.exports = {
    ensureExploreData,
    getRegionProgress,
    getMaxStamina,
    applyStaminaRegen,
    msUntilNextStamina,
    applyDailyReset,
    getLevelData,
    xpToNextLevel,
    getExplorerPrestige,
    getExplorerTitle,
    canPrestige,
    getRelicBonusCap,
    getRelicCapacity,
    relicCapacityForBonus,
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
    applyExploreXpBonus,
    rollTreasureMaterial,
    grantTreasureMaterial,
    EXPLORE_MATERIALS_BY_TIER,
    regionCompletion,
    renderMap,
    formatMs,
    REGIONS,
};
