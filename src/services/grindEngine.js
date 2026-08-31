'use strict';

// The mechanics /hunt, /fish, /mine and /explore share, in one place (#892).
//
// The four gathering subsystems are near-parallel implementations of one
// design, and the parts of it that are not about animals or fish or ore had
// simply been written out four times: the stamina bank, the rolling daily
// window, the level ladder, the countdown formatter. Around 5,600 lines of
// service code with the same shapes in it four times over, which means every
// mechanic change is made four times and the fourth one gets forgotten.
//
// It already had, and that is the argument for this file rather than a style
// preference. Three of the drifts this replaces:
//
//   - applyStaminaRegen wrote `staminaLastRegen` and marked the subdocument
//     modified on *every* call while stamina was full, so a bare /hunt profile
//     read was a database write. Explore had been fixed and the other three
//     had not.
//   - msUntilDailyReset took the subdocument and returned 0 for "no window" in
//     hunt, and took the user and returned null for the same thing in mine.
//   - xpToNextLevel returned a negative number in hunt, fish and mine when a
//     player's xp had run past their recorded level; explore clamped it.
//
// The engine is parameterised by a spec per subsystem — which key on the user
// document it lives under, which tables in data/<name>Data.js describe it, and
// which synergies feed its stamina bar. Everything past that (the roll tables,
// the encounter resolution, the quests) stays in the subsystem's own service,
// because that part genuinely differs.
//
// It also holds every grind's spec at once, which is what lets fishService ask
// for the hunt stamina bar — an energy drink refills both — without requiring
// huntService. That direct service-to-service require was the other half of
// #892: a lower-level mechanic reached for through a sibling that happens to
// own it.

const huntData = require('../data/huntData');
const fishData = require('../data/fishData');
const mineData = require('../data/mineData');
const exploreData = require('../data/exploreData');
const { MAX_STAMINA_UPGRADES } = require('../data/crossSystemData');
const {
    getGatheringYieldEffect,
    consumeEffect,
    getEffect,
    EFFECT_CONFIGS,
} = require('./effectsService');
const {
    getHuntSynergyStaminaBonus,
    getHuntWayfinderStaminaBonus,
    getFishSynergyStaminaBonus,
    getFishDeepProspectorStaminaBonus,
    getMineDeepProspectorStaminaBonus,
    getArtificerMineStaminaBonus,
    getExploreWayfinderStaminaBonus,
} = require('./synergyService');

/** The permanent +1 max stamina bought in the shop and applied through /use. */
function purchasedStamina(user) {
    return Math.min(Math.max(0, user?.staminaUpgrades ?? 0), MAX_STAMINA_UPGRADES);
}

/** The staminaBonus row for a prestige rank, clamped to the table. */
function prestigeStamina(table, rank) {
    return table[Math.min(Math.max(0, Number(rank) || 0), table.length - 1)]?.staminaBonus ?? 0;
}

/**
 * One grind, as the engine needs to see it.
 *
 * key            the user subdocument — `user.hunt`, `user.fishing`, …
 * limits         the subsystem's LIMITS table
 * maxStaminaBase LIMITS spells this MAX_STAMINA_BASE in three of the four and
 *                MAX_STAMINA in explore, so it is read here rather than there
 * levels         the level ladder, ascending, each row `{ level, xpRequired }`
 * staminaBonus   everything on top of the base: prestige, synergies, trophies,
 *                and the purchased upgrade where the subsystem honours one
 * dailyCounters  the per-window counters zeroed when the window rolls
 * dailyStaminaItem the daily stamina-item allowance, where there is one
 */
const GRINDS = {
    hunt: {
        key: 'hunt',
        limits: huntData.LIMITS,
        maxStaminaBase: huntData.LIMITS.MAX_STAMINA_BASE,
        levels: huntData.HUNTER_LEVELS,
        staminaBonus: user =>
            prestigeStamina(huntData.PRESTIGE_BONUSES, user.hunt?.prestige ?? 0)
            // Outdoorsman and Wayfinder both advertise +1 max hunt stamina;
            // they stack, exactly as Deep Prospector and Artificer do on mining.
            + getHuntSynergyStaminaBonus(user)
            + getHuntWayfinderStaminaBonus(user)
            + (user.hunt?.woodlandInstinct ? 1 : 0)
            + purchasedStamina(user),
        dailyCounters: ['dailyCoins', 'dailyHunts'],
        dailyStaminaItem: { used: 'staminaTonicsToday', lastReset: 'lastTonicDayReset' },
    },
    fish: {
        key: 'fishing',
        limits: fishData.LIMITS,
        maxStaminaBase: fishData.LIMITS.MAX_STAMINA_BASE,
        levels: fishData.FISHER_LEVELS,
        staminaBonus: user =>
            prestigeStamina(fishData.PRESTIGE_BONUSES, user.fishing?.prestige ?? 0)
            + getFishSynergyStaminaBonus(user)
            + getFishDeepProspectorStaminaBonus(user)
            + purchasedStamina(user),
        dailyCounters: ['dailyCoins', 'dailyCasts'],
        dailyStaminaItem: { used: 'energyDrinksToday', lastReset: 'lastDrinkDayReset' },
    },
    mine: {
        key: 'mining',
        limits: mineData.LIMITS,
        maxStaminaBase: mineData.LIMITS.MAX_STAMINA_BASE,
        levels: mineData.MINER_LEVELS,
        staminaBonus: user =>
            prestigeStamina(mineData.PRESTIGE_BONUSES, user.mining?.prestige ?? 0)
            + getMineDeepProspectorStaminaBonus(user)
            + getArtificerMineStaminaBonus(user)
            + purchasedStamina(user),
        dailyCounters: ['dailyCoins', 'dailyMines'],
        dailyStaminaItem: { used: 'energyTonicsToday', lastReset: 'lastTonicDayReset' },
    },
    explore: {
        key: 'exploration',
        limits: exploreData.LIMITS,
        maxStaminaBase: exploreData.LIMITS.MAX_STAMINA,
        levels: exploreData.EXPLORER_LEVELS,
        // Explore's prestige table is its own shape — its ranks carry relic
        // and secret bonuses too, read through exploreService — but the
        // stamina row on it is the same row every other grind has. Explore is
        // also the one grind with no purchased stamina upgrade.
        staminaBonus: user =>
            getExploreWayfinderStaminaBonus(user)
            + prestigeStamina(exploreData.EXPLORER_PRESTIGE, user?.exploration?.prestige),
        dailyCounters: ['dailyCoins', 'dailyExpeditions'],
        // Explore has no stamina consumable, so it has no daily allowance to
        // reset alongside the window.
        dailyStaminaItem: null,
    },
};

function specFor(grind) {
    const spec = GRINDS[grind];
    if (!spec) throw new Error(`grindEngine: unknown grind "${grind}"`);
    return spec;
}

/** The subdocument, or undefined when the caller has not ensured it yet. */
function dataFor(user, grind) {
    return user?.[specFor(grind).key];
}

// ─── THE FIELDS THE ENGINE OWNS ──────────────────────────────────────────────

/**
 * Seed the fields this engine reads and writes, and nothing else.
 *
 * Each subsystem's own `ensure<Name>Data` seeds the rest — weapons, zones,
 * rods, depths, the mine map — and calls this first for the shared half, so
 * "what a stamina bar starts at" has one definition rather than four that were
 * only accidentally the same number.
 *
 * It is also what a *sibling* grind can call: an energy drink refills the fish
 * and hunt bars together, and a winter-hunt catch drops a material into the
 * hunt bag, so fishService has to be able to touch `user.hunt` safely. It used
 * to do that by requiring huntService outright, which is the service-to-service
 * coupling #892 is about; this is the same guarantee without the edge.
 *
 * @returns {boolean} whether anything was written.
 */
function ensureSharedFields(user, grind) {
    const spec = specFor(grind);
    let dirty = false;

    if (!user[spec.key]) {
        user[spec.key] = {};
        dirty = true;
    }
    const d = user[spec.key];

    const seed = (key, value) => {
        if (d[key] == null) { d[key] = value; dirty = true; }
    };

    seed('stamina', spec.maxStaminaBase);
    seed('xp', 0);
    seed('level', 1);
    seed('prestige', 0);
    for (const counter of spec.dailyCounters) seed(counter, 0);
    // Timestamps that legitimately sit at null until something happens: `seed`
    // would not distinguish "absent" from "not yet", so they are set by key.
    for (const key of ['staminaLastRegen', 'dailyWindowStart']) {
        if (!(key in d)) { d[key] = null; dirty = true; }
    }
    if (spec.dailyStaminaItem) {
        seed(spec.dailyStaminaItem.used, 0);
        if (!(spec.dailyStaminaItem.lastReset in d)) {
            d[spec.dailyStaminaItem.lastReset] = null;
            dirty = true;
        }
    }
    // Crafting materials, keyed by material id. All four grinds hold the same
    // shape, which is what lets /pet feed and the inventory tabs read them the
    // same way.
    if (!d.materials || typeof d.materials !== 'object') { d.materials = {}; dirty = true; }

    if (dirty) user.markModified(spec.key);
    return dirty;
}

/**
 * Add stamina to a grind's bar, clamped to that grind's ceiling.
 *
 * The bar may belong to a *different* subsystem than the one being played: the
 * fishing energy drink and the hunting stamina tonic each refill both bars.
 *
 * @returns {{before: number, after: number, max: number, wasFull: boolean}}
 */
function restoreStamina(user, grind, amount) {
    const spec = specFor(grind);
    ensureSharedFields(user, grind);

    const d = user[spec.key];
    const max = getMaxStamina(user, grind);
    const before = d.stamina;
    const after = Math.min(max, before + amount);

    if (after !== before) {
        d.stamina = after;
        user.markModified(spec.key);
    }
    return { before, after, max, wasFull: before >= max };
}

// ─── STAMINA ─────────────────────────────────────────────────────────────────

/** The player's ceiling: the subsystem base plus everything that lifts it. */
function getMaxStamina(user, grind) {
    const spec = specFor(grind);
    return spec.maxStaminaBase + spec.staminaBonus(user);
}

/**
 * Credit whatever stamina has accrued since the last regen tick.
 *
 * The anchor advances by exactly the intervals consumed rather than to now, so
 * the remainder carries and a player loses nothing to rounding across reads.
 *
 * At full it refreshes the anchor only once it has actually gone stale — the
 * clock should start from roughly the moment stamina is next spent, but
 * rewriting it on every read made a profile view a database write. Explore was
 * the only one of the four that did this; now all four do.
 *
 * @returns {boolean} whether anything was changed and marked modified.
 */
function applyStaminaRegen(user, grind) {
    const spec = specFor(grind);
    const d = user[spec.key];
    const max = getMaxStamina(user, grind);
    const regenMs = spec.limits.STAMINA_REGEN_MS;

    if (d.stamina >= max) {
        const stale = !d.staminaLastRegen
            || Date.now() - d.staminaLastRegen.getTime() >= regenMs;
        const overfull = d.stamina > max;
        d.stamina = max;
        if (!stale && !overfull) return false;
        d.staminaLastRegen = new Date();
        user.markModified(spec.key);
        return true;
    }

    if (!d.staminaLastRegen) {
        d.staminaLastRegen = new Date();
        user.markModified(spec.key);
        return true;
    }

    const intervals = Math.floor((Date.now() - d.staminaLastRegen.getTime()) / regenMs);
    if (intervals <= 0) return false;

    d.stamina = Math.min(max, d.stamina + intervals);
    d.staminaLastRegen = new Date(d.staminaLastRegen.getTime() + intervals * regenMs);
    user.markModified(spec.key);
    return true;
}

/** How long until the next point, or 0 when the bar is full. */
function msUntilNextStamina(user, grind) {
    const spec = specFor(grind);
    const d = user[spec.key];
    const regenMs = spec.limits.STAMINA_REGEN_MS;

    if (d.stamina >= getMaxStamina(user, grind)) return 0;
    if (!d.staminaLastRegen) return regenMs;

    const elapsed = Date.now() - d.staminaLastRegen.getTime();
    return Math.max(0, regenMs - (elapsed % regenMs));
}

// ─── THE ROLLING DAILY WINDOW ────────────────────────────────────────────────

/**
 * How long is left in the current window, or null when none has started.
 *
 * null rather than 0 because they mean opposite things — a window that has run
 * out is 0 and resets on the next action, a player who has never acted has no
 * window at all. Hunt returned 0 for both and mine returned null for the
 * second; this is mine's answer, and it is the one a caller can act on.
 */
function msUntilDailyReset(user, grind) {
    const spec = specFor(grind);
    const start = user?.[spec.key]?.dailyWindowStart;
    if (!start) return null;
    return Math.max(0, spec.limits.DAILY_WINDOW_MS - (Date.now() - start.getTime()));
}

/**
 * Roll the window over if it has expired, zeroing the daily counters and the
 * daily stamina-item allowance together.
 *
 * @returns {boolean} whether the window rolled.
 */
function applyDailyReset(user, grind) {
    const spec = specFor(grind);
    const d = user[spec.key];
    const now = Date.now();

    if (d.dailyWindowStart && now - d.dailyWindowStart.getTime() < spec.limits.DAILY_WINDOW_MS) {
        return false;
    }

    for (const counter of spec.dailyCounters) d[counter] = 0;
    d.dailyWindowStart = new Date(now);
    if (spec.dailyStaminaItem) {
        d[spec.dailyStaminaItem.used] = 0;
        d[spec.dailyStaminaItem.lastReset] = new Date(now);
    }
    user.markModified(spec.key);
    return true;
}

// ─── THE DAILY PAYOUT THROTTLE ───────────────────────────────────────────────

// Past the soft cap a payout is halved. Past the hard cap it is nothing, and
// what is left between the two is the day's remaining headroom.
const SOFT_CAP_RATE = 0.50;

/**
 * The state of a player's daily earnings, and the clamp that settles a payout
 * against it.
 *
 * `settle` is the whole rule in one place: halve past the soft cap, clamp to
 * the headroom under the hard cap, never below zero. It is applied to the
 * doubled figure as well as the plain one, which is how the caller can tell
 * whether doubling would actually pay anything before it spends a charge.
 *
 * @returns {{cappedByHard: boolean, softCapped: boolean, remaining: number,
 *   settle: (raw: number) => number}}
 */
function dailyThrottle(user, grind) {
    const spec = specFor(grind);
    const { DAILY_SOFT_CAP, DAILY_HARD_CAP } = spec.limits;
    const earned = user[spec.key]?.dailyCoins ?? 0;

    const softCapped = earned >= DAILY_SOFT_CAP;
    const remaining = Math.max(0, DAILY_HARD_CAP - earned);

    return {
        cappedByHard: earned >= DAILY_HARD_CAP,
        softCapped,
        remaining,
        settle: raw => Math.max(0, Math.min(softCapped ? Math.round(raw * SOFT_CAP_RATE) : raw, remaining)),
    };
}

/**
 * Spend a Silvered Talisman / Voidsteel Cache charge, if one is active and it
 * would actually pay.
 *
 * The condition is the point: within a hair of the daily hard cap the headroom
 * clamp swallows the whole bonus, and a charge that buys nothing must not be
 * spent. Hunt and mine each carried this rule; fishing checked only that the
 * payout was non-zero, so an angler at the cap lost a charge for nothing (#892).
 *
 * @param {number} basePayout the settled payout without the doubling.
 * @param {number} doubledPayout the settled payout with it.
 * @returns {{effect: string, label: string, emoji: string, chargesLeft: number}|null}
 *   null when there is no charge to spend or spending it would buy nothing.
 */
function claimGatheringYield(user, basePayout, doubledPayout) {
    if (doubledPayout <= basePayout) return null;

    const effect = getGatheringYieldEffect(user);
    if (!effect) return null;

    consumeEffect(user, effect);
    const cfg = EFFECT_CONFIGS[effect];
    return {
        effect,
        label: cfg?.label ?? effect.replace(/_/g, ' '),
        emoji: cfg?.emoji ?? '✨',
        chargesLeft: getEffect(user, effect)?.charges ?? 0,
    };
}

// ─── THE LEVEL LADDER ────────────────────────────────────────────────────────

/** The highest level the ladder grants for a total xp figure. */
function levelFromXp(totalXp, grind) {
    const { levels } = specFor(grind);
    let level = 1;
    for (const row of levels) {
        if (totalXp >= row.xpRequired) level = row.level;
        else break;
    }
    return level;
}

/** The ladder row for a level, clamped to the table at both ends. */
function getLevelData(level, grind) {
    const { levels } = specFor(grind);
    const row = Math.min(Math.max(1, level), levels.length) - 1;
    return levels[row];
}

/**
 * The xp still owed for the next rung, or null at the top of the ladder.
 *
 * Clamped at zero: a player whose xp has run past their recorded level — a
 * failed save, a hand-edited document — owes nothing rather than a negative
 * amount that renders as "-40 XP to go".
 */
function xpToNextLevel(currentLevel, currentXp, grind) {
    const { levels } = specFor(grind);
    if (currentLevel >= levels.length) return null;
    return Math.max(0, levels[currentLevel].xpRequired - currentXp);
}

/**
 * Credit xp and settle the level against the ladder.
 *
 * The new level is read off the whole table rather than incremented, so one
 * large award can carry a player up several rungs at once.
 */
function applyXp(user, xpGain, grind) {
    const spec = specFor(grind);
    const d = user[spec.key];
    const oldLevel = d.level;

    d.xp += xpGain;
    const newLevel = levelFromXp(d.xp, grind);

    if (newLevel > oldLevel) {
        d.level = newLevel;
        user.markModified(spec.key);
        return { oldLevel, newLevel, leveledUp: true };
    }
    return { oldLevel, newLevel: oldLevel, leveledUp: false };
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────

/**
 * A countdown, coarsest useful unit first.
 *
 * Rounded up, because this reads "next stamina in 1s" rather than "in 0s" for
 * the last fraction of a second before it lands — three of the four rounded
 * down and printed a countdown that reached zero before the thing happened.
 */
function formatMs(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

module.exports = {
    GRINDS,
    specFor,
    dataFor,
    ensureSharedFields,
    restoreStamina,
    getMaxStamina,
    applyStaminaRegen,
    msUntilNextStamina,
    msUntilDailyReset,
    applyDailyReset,
    SOFT_CAP_RATE,
    dailyThrottle,
    claimGatheringYield,
    levelFromXp,
    getLevelData,
    xpToNextLevel,
    applyXp,
    formatMs,
};
