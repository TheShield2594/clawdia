'use strict';

const {
    LIMITS,
    EXPLORER_LEVELS,
    EVENT_XP,
    TREASURE_TIERS,
    REGIONS,
    REGION_LIST,
    QUIET_LINES,
} = require('../data/exploreData');

// ─── INIT ────────────────────────────────────────────────────────────────────

function ensureExploreData(user) {
    if (!user.exploration) user.exploration = {};
    const e = user.exploration;

    if (e.stamina          == null) e.stamina          = LIMITS.MAX_STAMINA;
    if (e.staminaLastRegen == null) e.staminaLastRegen = null;
    if (e.xp               == null) e.xp               = 0;
    if (e.level            == null) e.level            = 1;
    if (e.lastExplore      == null) e.lastExplore      = null;
    if (e.injuryUntil      == null) e.injuryUntil      = null;
    if (e.activeRegion     == null) e.activeRegion     = 'whispering_forest';
    if (!Array.isArray(e.unlockedRegions)) e.unlockedRegions = [];
    if (!Array.isArray(e.regions))         e.regions         = [];
    if (!Array.isArray(e.journal))         e.journal         = [];

    if (e.totalExpeditions     == null) e.totalExpeditions     = 0;
    if (e.treasuresFound       == null) e.treasuresFound       = 0;
    if (e.trapsSprung          == null) e.trapsSprung          = 0;
    if (e.encountersWon        == null) e.encountersWon        = 0;
    if (e.secretsFound         == null) e.secretsFound         = 0;
    if (e.loreCollected        == null) e.loreCollected        = 0;
    if (e.landmarksDiscovered  == null) e.landmarksDiscovered  = 0;
    if (e.relicsRecovered      == null) e.relicsRecovered      = 0;
    if (e.totalEarned          == null) e.totalEarned          = 0;
    if (e.bestHaul             == null) e.bestHaul             = 0;
    if (e.sinceSecret          == null) e.sinceSecret          = 0;

    if (e.dailyCoins        == null) e.dailyCoins        = 0;
    if (e.dailyExpeditions  == null) e.dailyExpeditions  = 0;
    if (e.dailyWindowStart  == null) e.dailyWindowStart  = null;

    if (!e.unlockedRegions.includes('whispering_forest')) {
        e.unlockedRegions.push('whispering_forest');
    }

    user.markModified('exploration');
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

function applyStaminaRegen(user) {
    const e = user.exploration;
    const max = LIMITS.MAX_STAMINA;
    if (e.stamina >= max) {
        e.stamina = max;
        e.staminaLastRegen = new Date();
        user.markModified('exploration');
        return;
    }
    if (!e.staminaLastRegen) {
        e.staminaLastRegen = new Date();
        user.markModified('exploration');
        return;
    }
    const elapsed = Date.now() - e.staminaLastRegen.getTime();
    const intervals = Math.floor(elapsed / LIMITS.STAMINA_REGEN_MS);
    if (intervals <= 0) return;

    e.stamina = Math.min(max, e.stamina + intervals);
    e.staminaLastRegen = new Date(e.staminaLastRegen.getTime() + intervals * LIMITS.STAMINA_REGEN_MS);
    user.markModified('exploration');
}

function msUntilNextStamina(user) {
    const e = user.exploration;
    if (e.stamina >= LIMITS.MAX_STAMINA) return 0;
    if (!e.staminaLastRegen) return LIMITS.STAMINA_REGEN_MS;
    const elapsed = Date.now() - e.staminaLastRegen.getTime();
    return Math.max(0, LIMITS.STAMINA_REGEN_MS - (elapsed % LIMITS.STAMINA_REGEN_MS));
}

function applyDailyReset(user) {
    const e = user.exploration;
    const now = Date.now();
    if (!e.dailyWindowStart || now - e.dailyWindowStart.getTime() >= LIMITS.DAILY_WINDOW_MS) {
        e.dailyCoins       = 0;
        e.dailyExpeditions = 0;
        e.dailyWindowStart = new Date(now);
        user.markModified('exploration');
    }
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

// ─── RNG ─────────────────────────────────────────────────────────────────────

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
        return e.unlockedRegions.includes(r.id);
    });
}

// ─── EVENT ROLL ──────────────────────────────────────────────────────────────

/**
 * Roll the event type for an expedition into a region.
 * Admin rareEventBonus and the secret pity counter shift weight toward
 * the rarer slots.
 */
function rollEventType(user, region, guildSettings) {
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

    // Secret pity: long droughts self-correct
    const pity = Math.min(
        LIMITS.SECRET_PITY_MAX,
        (user.exploration.sinceSecret ?? 0) * LIMITS.SECRET_PITY_PER_RUN
    );
    w.secret += pity;

    const items = Object.entries(w)
        .map(([type, weight]) => ({ type, weight }))
        .filter(i => i.weight > 0);
    return weightedRoll(items).type;
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

    e.stamina -= 1;
    e.lastExplore = new Date();
    e.totalExpeditions += 1;
    e.dailyExpeditions += 1;
    progress.expeditions += 1;

    const dropRate = clamp(guildSettings?.exploration?.dropRateMultiplier ?? 1, 0.1, 5);
    const coinMult = (opts.coinMultiplier ?? 1) * dropRate * region.payoutMultiplier;

    const result = {
        regionId: region.id,
        firstVisit,
        type: rollEventType(user, region, guildSettings),
        payout: 0,
        xp: 0,
        intro: randomFrom(region.intros),
        coinMultiplier: opts.coinMultiplier ?? 1,
    };

    switch (result.type) {
        case 'discovery': {
            const unfound = region.landmarks.filter(l => !progress.landmarksFound.includes(l.id));
            if (unfound.length === 0) {
                // Region fully charted — fall through to a modest treasure
                return finishAsTreasure(user, region, progress, result, coinMult, { smallOnly: true });
            }
            const landmark = randomFrom(unfound);
            progress.landmarksFound.push(landmark.id);
            e.landmarksDiscovered += 1;
            result.landmark = landmark;
            result.payout = applyPayout(user, Math.round(randInt(300, 700) * coinMult));
            result.xp = grantXp(user, EVENT_XP.discovery);
            break;
        }

        case 'lore': {
            const unfound = region.lore.filter(l => !progress.loreFound.includes(l.id));
            if (unfound.length === 0) {
                return finishAsTreasure(user, region, progress, result, coinMult, { smallOnly: true });
            }
            const fragment = randomFrom(unfound);
            progress.loreFound.push(fragment.id);
            e.loreCollected += 1;
            result.lore = fragment;
            result.payout = applyPayout(user, Math.round(randInt(150, 400) * coinMult));
            result.xp = grantXp(user, EVENT_XP.lore);
            break;
        }

        case 'secret': {
            const unfound = region.secrets.filter(s => !progress.secretsFound.includes(s.id));
            if (unfound.length === 0) {
                return finishAsTreasure(user, region, progress, result, coinMult);
            }
            const secret = randomFrom(unfound);
            progress.secretsFound.push(secret.id);
            e.secretsFound += 1;
            e.sinceSecret = 0;
            result.secret = secret;
            result.payout = applyPayout(user, Math.round(secret.reward * coinMult));
            result.xp = grantXp(user, EVENT_XP.secret);
            break;
        }

        case 'treasure': {
            return finishAsTreasure(user, region, progress, result, coinMult);
        }

        case 'trap': {
            const trap = randomFrom(region.traps);
            const rawPenalty = randInt(trap.penalty.min, trap.penalty.max);
            const penalty = Math.min(rawPenalty, Math.max(0, user.balance));
            user.balance -= penalty;
            e.trapsSprung += 1;
            result.trap = trap;
            result.penalty = penalty;
            result.xp = grantXp(user, EVENT_XP.trap);
            if (Math.random() < trap.injuryChance) {
                e.injuryUntil = new Date(Date.now() + LIMITS.INJURY_PENALTY_MS);
                result.injured = true;
            }
            break;
        }

        case 'encounter': {
            // Pending: command layer resolves via resolveEncounter()
            result.encounter = randomFrom(region.encounters);
            result.pendingChoice = true;
            break;
        }

        case 'quiet':
        default: {
            result.type = 'quiet';
            result.quietLine = randomFrom(QUIET_LINES);
            result.xp = grantXp(user, EVENT_XP.quiet);
            break;
        }
    }

    if (result.type !== 'secret' && !result.pendingChoice) {
        e.sinceSecret += 1;
    }

    finalizeStats(user, result);
    user.markModified('exploration');
    return result;
}

/**
 * Resolve a pending encounter after the player chose.
 * @param {string} choice - 'approach' | 'observe' | null (timeout = observe)
 */
function resolveEncounter(user, region, guildSettings, result, choice) {
    const e = user.exploration;
    const enc = result.encounter;
    const dropRate = clamp(guildSettings?.exploration?.dropRateMultiplier ?? 1, 0.1, 5);
    const coinMult = (result.coinMultiplier ?? 1) * dropRate * region.payoutMultiplier;

    result.pendingChoice = false;
    result.choice = choice === 'approach' ? 'approach' : 'observe';

    if (result.choice === 'approach') {
        if (Math.random() < enc.winChance) {
            result.outcome = 'win';
            e.encountersWon += 1;
            result.payout = applyPayout(user, Math.round(randInt(enc.reward.min, enc.reward.max) * coinMult));
            result.xp = grantXp(user, EVENT_XP.encounter_win);
        } else {
            result.outcome = 'loss';
            const penalty = Math.min(Math.round(randInt(200, 600) * dropRate), Math.max(0, user.balance));
            user.balance -= penalty;
            result.penalty = penalty;
            result.xp = grantXp(user, EVENT_XP.encounter_loss);
            if (Math.random() < 0.15) {
                e.injuryUntil = new Date(Date.now() + LIMITS.INJURY_PENALTY_MS);
                result.injured = true;
            }
        }
    } else {
        result.outcome = 'safe';
        result.payout = applyPayout(user, Math.round(randInt(enc.reward.min, enc.reward.max) * coinMult * 0.35));
        result.xp = grantXp(user, EVENT_XP.encounter_safe);
    }

    e.sinceSecret += 1;
    finalizeStats(user, result);
    user.markModified('exploration');
    return result;
}

// Treasure resolution, also used as the fallback when a region is fully charted
function finishAsTreasure(user, region, progress, result, coinMult, { smallOnly = false } = {}) {
    const e = user.exploration;
    result.type = 'treasure';

    let tier = rollTreasureTier();
    if (smallOnly && ['epic', 'legendary'].includes(tier.tier)) {
        tier = TREASURE_TIERS.find(t => t.tier === 'uncommon');
    }
    result.treasureTier = tier;
    result.treasureLine = randomFrom(region.treasureLines);
    result.payout = applyPayout(user, Math.round(randInt(tier.min, tier.max) * coinMult));
    result.xp = grantXp(user, EVENT_XP.treasure);
    e.treasuresFound += 1;

    // Rare+ treasures may carry a relic into the player's inventory
    if (!smallOnly && Math.random() < tier.relicChance) {
        const pool = region.relics.filter(r =>
            tier.tier === 'legendary' ? true : r.rarity !== 'legendary'
        );
        if (pool.length) {
            const relic = randomFrom(pool);
            addRelicToInventory(user, relic);
            e.relicsRecovered += 1;
            result.relic = relic;
        }
    }

    e.sinceSecret += 1;
    finalizeStats(user, result);
    user.markModified('exploration');
    return result;
}

// ─── REWARD HELPERS ──────────────────────────────────────────────────────────

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

// Credit coins, respecting the rolling daily hard cap. Returns amount granted.
function applyPayout(user, amount) {
    const e = user.exploration;
    const remaining = Math.max(0, LIMITS.DAILY_HARD_CAP - e.dailyCoins);
    const granted = Math.min(amount, remaining);
    if (granted > 0) {
        user.balance       += granted;
        e.totalEarned      += granted;
        e.dailyCoins       += granted;
    }
    return granted;
}

// Explorer XP + report the amount so the command layer can mirror it into guild XP
function grantXp(user, amount) {
    applyExplorerXp(user, amount);
    return amount;
}

function addRelicToInventory(user, relic) {
    if (!user.inventory) user.inventory = [];
    const existing = user.inventory.find(i => i.itemId === relic.itemId);
    if (existing) existing.quantity += 1;
    else user.inventory.push({ itemId: relic.itemId, quantity: 1 });
    user.markModified('inventory');
}

function finalizeStats(user, result) {
    const e = user.exploration;
    if (result.payout > e.bestHaul) e.bestHaul = result.payout;
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
        lines.push(
            `${region.emoji} **${region.name}** — ${pct}% charted${seasonalTag}\n` +
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
    executeExplore,
    resolveEncounter,
    addJournalEntry,
    regionCompletion,
    renderMap,
    formatMs,
    REGIONS,
};
