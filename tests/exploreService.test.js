'use strict';

const {
    ensureExploreData,
    applyStaminaRegen,
    applyDailyReset,
    applyExplorerXp,
    xpToNextLevel,
    getLevelData,
    isRegionInSeason,
    isRegionEnabled,
    isRegionFullyCharted,
    getAvailableRegions,
    resolveActiveRegion,
    getRelicCollection,
    getRelicBonus,
    buildEventWeights,
    getSecretOdds,
    getPayoutMultiplier,
    getPenaltyMultiplier,
    executeExplore,
    resolveEncounter,
    addJournalEntry,
    regionCompletion,
    renderMap,
} = require('../src/services/exploreService');
const {
    LIMITS,
    REGIONS,
    REGION_LIST,
    RELIC_LIST,
    RELIC_INDEX,
    RELIC_VALUES,
    RELIC_EMOJI,
    RELIC_RARITY_ORDER,
    TOTAL_CORE_SECRETS,
    EXPLORER_LEVELS,
    getRelicMeta,
} = require('../src/data/exploreData');

function makeUser(overrides = {}) {
    const user = {
        balance: 50_000,
        inventory: [],
        markModified: jest.fn(),
        ...overrides,
    };
    ensureExploreData(user);
    return user;
}

function makeGuildSettings(overrides = {}) {
    return {
        exploration: { enabled: true, dropRateMultiplier: 1, rareEventBonus: 0, disabledRegions: [] },
        ...overrides,
    };
}

// Marks a region as fully explored on the user's progress record.
function chartRegion(user, region, { landmarks = true, lore = true, secrets = true } = {}) {
    const rec = {
        regionId: region.id,
        discoveredAt: new Date(),
        expeditions: 1,
        landmarksFound: landmarks ? region.landmarks.map(l => l.id) : [],
        loreFound:      lore     ? region.lore.map(l => l.id)       : [],
        secretsFound:   secrets  ? region.secrets.map(s => s.id)    : [],
    };
    user.exploration.regions.push(rec);
    return rec;
}

// Math.random replacement that plays a fixed script, then holds the last value.
function scriptRandom(values) {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

function withRandom(fn, impl) {
    const original = Math.random;
    Math.random = impl;
    try { return fn(); } finally { Math.random = original; }
}

describe('exploreData integrity', () => {
    test('has 5 core and 5 seasonal regions', () => {
        const core = REGION_LIST.filter(r => !r.seasonalEventId);
        const seasonal = REGION_LIST.filter(r => r.seasonalEventId);
        expect(core).toHaveLength(5);
        expect(seasonal).toHaveLength(5);

        const arcticTundra = REGION_LIST.find(r => r.id === 'arctic_tundra');
        expect(arcticTundra).toBeDefined();
        expect(arcticTundra.seasonalEventId).toBe('winter_hunt');
    });

    test('core regions hold 20 secrets total (matches achievement target)', () => {
        expect(TOTAL_CORE_SECRETS).toBe(20);
    });

    test('every region has a complete event table', () => {
        for (const region of REGION_LIST) {
            for (const slot of ['encounter', 'discovery', 'trap', 'treasure', 'lore', 'secret', 'quiet']) {
                expect(region.eventWeights[slot]).toBeGreaterThan(0);
            }
        }
    });

    test('landmark/lore/secret ids are globally unique', () => {
        const ids = REGION_LIST.flatMap(r => [
            ...r.landmarks.map(l => l.id),
            ...r.lore.map(l => l.id),
            ...r.secrets.map(s => s.id),
        ]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('explorer level table is strictly increasing', () => {
        for (let i = 1; i < EXPLORER_LEVELS.length; i++) {
            expect(EXPLORER_LEVELS[i].xpRequired).toBeGreaterThan(EXPLORER_LEVELS[i - 1].xpRequired);
        }
    });
});

describe('ensureExploreData', () => {
    test('initialises defaults and the starter region', () => {
        const user = makeUser();
        expect(user.exploration.stamina).toBe(LIMITS.MAX_STAMINA);
        expect(user.exploration.level).toBe(1);
        expect(user.exploration.activeRegion).toBe('whispering_forest');
        expect(user.exploration.unlockedRegions).toContain('whispering_forest');
    });
});

describe('stamina regen', () => {
    test('regenerates one point per interval', () => {
        const user = makeUser();
        user.exploration.stamina = 5;
        user.exploration.staminaLastRegen = new Date(Date.now() - 2 * LIMITS.STAMINA_REGEN_MS);
        applyStaminaRegen(user);
        expect(user.exploration.stamina).toBe(7);
    });

    test('never exceeds the cap', () => {
        const user = makeUser();
        user.exploration.stamina = 9;
        user.exploration.staminaLastRegen = new Date(Date.now() - 50 * LIMITS.STAMINA_REGEN_MS);
        applyStaminaRegen(user);
        expect(user.exploration.stamina).toBe(LIMITS.MAX_STAMINA);
    });
});

describe('daily window', () => {
    test('resets coins and expedition count after 24h', () => {
        const user = makeUser();
        user.exploration.dailyCoins = 5_000;
        user.exploration.dailyExpeditions = 12;
        user.exploration.dailyWindowStart = new Date(Date.now() - LIMITS.DAILY_WINDOW_MS - 1);
        applyDailyReset(user);
        expect(user.exploration.dailyCoins).toBe(0);
        expect(user.exploration.dailyExpeditions).toBe(0);
    });
});

describe('explorer XP', () => {
    test('crosses multiple levels in one grant', () => {
        const user = makeUser();
        applyExplorerXp(user, 1_000);
        expect(user.exploration.level).toBeGreaterThanOrEqual(5);
    });

    test('xpToNextLevel returns null at max level', () => {
        const max = EXPLORER_LEVELS[EXPLORER_LEVELS.length - 1];
        expect(xpToNextLevel(max.level, max.xpRequired)).toBeNull();
    });

    test('titles resolve for every level', () => {
        for (const entry of EXPLORER_LEVELS) {
            expect(getLevelData(entry.level).title).toBeTruthy();
        }
    });
});

describe('region availability', () => {
    test('seasonal region requires its matching active event', () => {
        const region = REGIONS.frostveil_pass;
        expect(isRegionInSeason(region, makeGuildSettings())).toBe(false);
        const withEvent = makeGuildSettings({
            activeEvent: { type: 'winter_wonderland', endsAt: new Date(Date.now() + 3_600_000) },
        });
        expect(isRegionInSeason(region, withEvent)).toBe(true);
    });

    test('expired seasonal event closes the region', () => {
        const withExpired = makeGuildSettings({
            activeEvent: { type: 'winter_wonderland', endsAt: new Date(Date.now() - 1) },
        });
        expect(isRegionInSeason(REGIONS.frostveil_pass, withExpired)).toBe(false);
    });

    test('admin-disabled regions are excluded everywhere', () => {
        const settings = makeGuildSettings();
        settings.exploration.disabledRegions = ['whispering_forest'];
        expect(isRegionEnabled(REGIONS.whispering_forest, settings)).toBe(false);
        const user = makeUser();
        const available = getAvailableRegions(user, settings);
        expect(available.find(r => r.id === 'whispering_forest')).toBeUndefined();
    });
});

describe('executeExplore', () => {
    test('consumes stamina and records the expedition', () => {
        const user = makeUser();
        // 0.6 pins the roll to the treasure slot — a quiet roll refunds the
        // stamina point and would make this assertion a coin flip.
        const result = withRandom(
            () => executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {}),
            () => 0.6,
        );
        expect(result.type).toBe('treasure');
        expect(user.exploration.stamina).toBe(LIMITS.MAX_STAMINA - 1);
        expect(user.exploration.totalExpeditions).toBe(1);
        expect(result.firstVisit).toBe(true);
        expect(user.exploration.regions[0].regionId).toBe('whispering_forest');
    });

    test('payouts respect the daily hard cap', () => {
        const user = makeUser();
        user.exploration.dailyCoins = LIMITS.DAILY_HARD_CAP;
        user.exploration.dailyWindowStart = new Date();
        const before = user.balance;
        for (let i = 0; i < 30; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.lastExplore = null;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
        }
        // Capped: balance can only go down (traps/losses), never up
        expect(user.balance).toBeLessThanOrEqual(before);
    });

    test('trap penalties never push balance negative', () => {
        const user = makeUser({ balance: 0 });
        for (let i = 0; i < 100; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.sunken_docks, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.sunken_docks, makeGuildSettings(), r, 'approach');
            expect(user.balance).toBeGreaterThanOrEqual(0);
            user.exploration.dailyCoins = 0;
            user.balance = 0;
        }
    });

    test('secrets land on the map exactly once and reset pity', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        // Force the secret slot by exhausting pity weighting: run until all found
        let guard = 5_000;
        const progress = () => user.exploration.regions.find(r => r.regionId === region.id);
        while ((progress()?.secretsFound.length ?? 0) < region.secrets.length && guard-- > 0) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, region, makeGuildSettings(), r, 'observe');
            if (r.type === 'secret') expect(user.exploration.sinceSecret).toBe(0);
        }
        const found = progress().secretsFound;
        expect(new Set(found).size).toBe(found.length);
        expect(found.length).toBe(region.secrets.length);
    });

    test('relics stack in the shared inventory', () => {
        const user = makeUser();
        const region = REGIONS.crystal_caves;
        let guard = 10_000;
        while (user.exploration.relicsRecovered < 2 && guard-- > 0) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, region, makeGuildSettings(), r, 'observe');
        }
        const total = user.inventory.reduce((s, i) => s + i.quantity, 0);
        expect(total).toBe(user.exploration.relicsRecovered);
    });
});

describe('encounters', () => {
    function forceEncounter(user, region, settings) {
        let guard = 2_000;
        while (guard-- > 0) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, settings, {});
            if (r.pendingChoice) return r;
        }
        throw new Error('no encounter rolled');
    }

    test('observe always pays a smaller, safe reward', () => {
        const user = makeUser();
        const settings = makeGuildSettings();
        const r = forceEncounter(user, REGIONS.whispering_forest, settings);
        resolveEncounter(user, REGIONS.whispering_forest, settings, r, 'observe');
        expect(r.outcome).toBe('safe');
        expect(r.payout).toBeGreaterThan(0);
    });

    test('timeout (null choice) is treated as observing', () => {
        const user = makeUser();
        const settings = makeGuildSettings();
        const r = forceEncounter(user, REGIONS.whispering_forest, settings);
        resolveEncounter(user, REGIONS.whispering_forest, settings, r, null);
        expect(r.choice).toBe('observe');
    });
});

describe('journal', () => {
    test('caps at the configured length, newest first', () => {
        const user = makeUser();
        for (let i = 0; i < LIMITS.JOURNAL_CAP + 10; i++) {
            addJournalEntry(user, 'whispering_forest', 'quiet', `entry ${i}`);
        }
        expect(user.exploration.journal).toHaveLength(LIMITS.JOURNAL_CAP);
        expect(user.exploration.journal[0].summary).toBe(`entry ${LIMITS.JOURNAL_CAP + 9}`);
    });
});

describe('map rendering', () => {
    test('shows uncharted entries before first visit and progress after', () => {
        const user = makeUser();
        const settings = makeGuildSettings();
        let lines = renderMap(user, settings);
        expect(lines.join('\n')).toContain('uncharted');

        const r = executeExplore(user, REGIONS.whispering_forest, settings, {});
        if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, settings, r, 'observe');
        lines = renderMap(user, settings);
        expect(lines.join('\n')).toContain('Whispering Forest');
    });

    test('completion is 100% when everything is found', () => {
        const region = REGIONS.whispering_forest;
        const progress = {
            landmarksFound: region.landmarks.map(l => l.id),
            loreFound: region.lore.map(l => l.id),
            secretsFound: region.secrets.map(s => s.id),
        };
        expect(regionCompletion(region, progress)).toBe(100);
        expect(regionCompletion(region, null)).toBe(0);
    });

    test('hidden seasonal regions stay off the map until visited or in season', () => {
        const user = makeUser();
        const lines = renderMap(user, makeGuildSettings());
        expect(lines.join('\n')).not.toContain('Frostveil');
    });

    test('a fully surveyed region is flagged on the map', () => {
        const user = makeUser();
        chartRegion(user, REGIONS.whispering_forest);
        expect(renderMap(user, makeGuildSettings()).join('\n')).toContain('fully surveyed');
    });
});

describe('ensureExploreData idempotence', () => {
    test('reports a write on first seed and nothing on the second pass', () => {
        const user = { balance: 0, inventory: [], markModified: jest.fn() };
        expect(ensureExploreData(user)).toBe(true);
        expect(ensureExploreData(user)).toBe(false);
    });

    test('leaves null-by-default timestamps alone instead of rewriting them', () => {
        const user = makeUser();
        user.exploration.lastExplore = null;
        expect(ensureExploreData(user)).toBe(false);
    });
});

describe('stamina and daily reset report their writes', () => {
    test('a full, freshly anchored stamina bar is not rewritten', () => {
        const user = makeUser();
        user.exploration.staminaLastRegen = new Date();
        expect(applyStaminaRegen(user)).toBe(false);
    });

    test('a stale anchor at full stamina is refreshed once', () => {
        const user = makeUser();
        user.exploration.staminaLastRegen = new Date(Date.now() - 10 * LIMITS.STAMINA_REGEN_MS);
        expect(applyStaminaRegen(user)).toBe(true);
        expect(applyStaminaRegen(user)).toBe(false);
    });

    test('daily reset only reports the rollover', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date(Date.now() - LIMITS.DAILY_WINDOW_MS - 1);
        expect(applyDailyReset(user)).toBe(true);
        expect(applyDailyReset(user)).toBe(false);
    });
});

describe('active region fallback', () => {
    test('keeps a region that is still open', () => {
        const user = makeUser();
        const resolved = resolveActiveRegion(user, makeGuildSettings());
        expect(resolved.region.id).toBe('whispering_forest');
        expect(resolved.switched).toBe(false);
    });

    test('reroutes off a seasonal region once its event ends', () => {
        const user = makeUser();
        user.exploration.activeRegion = 'frostveil_pass';
        const resolved = resolveActiveRegion(user, makeGuildSettings());
        expect(resolved.switched).toBe(true);
        expect(resolved.from.id).toBe('frostveil_pass');
        expect(resolved.region.id).toBe('whispering_forest');
        expect(user.exploration.activeRegion).toBe('whispering_forest');
    });

    test('reroutes off a region an admin switched off', () => {
        const user = makeUser();
        user.exploration.unlockedRegions.push('crumbling_ruins');
        user.exploration.level = 10;
        user.exploration.activeRegion = 'crumbling_ruins';
        const settings = makeGuildSettings();
        settings.exploration.disabledRegions = ['crumbling_ruins'];
        expect(resolveActiveRegion(user, settings).region.id).toBe('whispering_forest');
    });

    test('prefers the richest core region the player has actually earned', () => {
        const user = makeUser();
        user.exploration.level = 12;
        user.exploration.unlockedRegions.push('crumbling_ruins', 'crystal_caves');
        user.exploration.activeRegion = 'frostveil_pass';
        expect(resolveActiveRegion(user, makeGuildSettings()).region.id).toBe('crystal_caves');
    });

    test('an unlocked region below its level requirement is not a fallback', () => {
        const user = makeUser();
        user.exploration.level = 4;
        user.exploration.unlockedRegions.push('crumbling_ruins');
        user.exploration.activeRegion = 'frostveil_pass';
        expect(resolveActiveRegion(user, makeGuildSettings()).region.id).toBe('whispering_forest');
    });
});

describe('losses do not scale with generosity', () => {
    function forceLoss(user, region, settings) {
        let guard = 2_000;
        while (guard-- > 0) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, settings, { coinMultiplier: settings.__coinMult ?? 1 });
            if (!r.pendingChoice) continue;
            // rand = 1 loses the encounter, maxes the penalty roll, dodges injury
            return withRandom(() => resolveEncounter(user, region, settings, r, 'approach'), () => 0.999999);
        }
        throw new Error('no encounter rolled');
    }

    test('an encounter loss ignores the event coin bonus and the drop-rate knob', () => {
        const region = REGIONS.whispering_forest;

        const plain = makeUser();
        const plainSettings = makeGuildSettings();
        const plainLoss = forceLoss(plain, region, plainSettings);

        const boosted = makeUser();
        const boostedSettings = makeGuildSettings();
        boostedSettings.exploration.dropRateMultiplier = 5;
        boostedSettings.__coinMult = 3;
        const boostedLoss = forceLoss(boosted, region, boostedSettings);

        expect(plainLoss.outcome).toBe('loss');
        expect(boostedLoss.outcome).toBe('loss');
        expect(boostedLoss.penalty).toBe(plainLoss.penalty);
        expect(plainLoss.penalty).toBe(600); // max roll × 1.0 region multiplier
    });

    test('a deeper region still costs more to fail in', () => {
        expect(getPenaltyMultiplier(REGIONS.starfall_wastes))
            .toBeGreaterThan(getPenaltyMultiplier(REGIONS.whispering_forest));
        expect(getPenaltyMultiplier(REGIONS.whispering_forest)).toBe(1.0);
    });

    test('trap penalties stay inside their hand-tuned range', () => {
        const user = makeUser({ balance: 10_000_000 });
        const region = REGIONS.starfall_wastes;
        const settings = makeGuildSettings();
        settings.exploration.dropRateMultiplier = 5;
        const worst = Math.max(...region.traps.map(t => t.penalty.max));
        for (let i = 0; i < 400; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, settings, { coinMultiplier: 3 });
            if (r.type === 'trap') expect(r.penalty).toBeLessThanOrEqual(worst);
        }
    });
});

describe('daily cap visibility', () => {
    test('a capped payout reports the gross amount it was trimmed from', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        user.exploration.dailyCoins = LIMITS.DAILY_HARD_CAP;

        let capped = null;
        for (let i = 0; i < 400 && !capped; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
            if (r.cappedByDailyCap) capped = r;
        }

        expect(capped).not.toBeNull();
        expect(capped.payout).toBe(0);
        expect(capped.grossPayout).toBeGreaterThan(0);
    });

    test('a partially capped payout still records what it would have been', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        user.exploration.dailyCoins = LIMITS.DAILY_HARD_CAP - 50;

        let capped = null;
        for (let i = 0; i < 400 && !capped; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
            if (r.cappedByDailyCap && r.payout > 0) capped = r;
        }

        expect(capped).not.toBeNull();
        expect(capped.grossPayout).toBeGreaterThan(capped.payout);
        expect(user.exploration.dailyCoins).toBe(LIMITS.DAILY_HARD_CAP);
    });
});

describe('secret pity tells the truth', () => {
    test('an uncovered region never rolls a secret and never builds pity', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        chartRegion(user, region);
        const settings = makeGuildSettings();

        for (let i = 0; i < 400; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, settings, {});
            if (r.pendingChoice) resolveEncounter(user, region, settings, r, 'observe');
            expect(r.type).not.toBe('secret');
        }
        expect(user.exploration.sinceSecret).toBe(0);
    });

    test('getSecretOdds reports exhaustion instead of a chance', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const progress = chartRegion(user, region);
        expect(getSecretOdds(user, region, progress).exhausted).toBe(true);
    });

    test('the quoted odds use the same table the roll does', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const progress = chartRegion(user, region, { secrets: false });

        const plain = makeGuildSettings();
        const boosted = makeGuildSettings();
        boosted.exploration.rareEventBonus = 0.25;

        // rareEventBonus shifts weight into the secret slot; the display must
        // move with it or it quotes a chance the roll never uses.
        expect(buildEventWeights(region, boosted).secret)
            .toBeGreaterThan(buildEventWeights(region, plain).secret);
        expect(getSecretOdds(user, region, progress, boosted).baseChance)
            .toBeGreaterThan(getSecretOdds(user, region, progress, plain).baseChance);
    });

    test('pity lifts the secret chance above its base rate', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const progress = chartRegion(user, region, { secrets: false });

        const cold = getSecretOdds(user, region, progress);
        user.exploration.sinceSecret = 60;
        const hot = getSecretOdds(user, region, progress);

        expect(cold.chance).toBeCloseTo(cold.baseChance, 10);
        expect(hot.chance).toBeGreaterThan(hot.baseChance);
        expect(hot.pity).toBe(LIMITS.SECRET_PITY_MAX);
    });

    test('expeditions into a region with secrets left do build pity', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const settings = makeGuildSettings();
        for (let i = 0; i < 20; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, settings, {});
            if (r.pendingChoice) resolveEncounter(user, region, settings, r, 'observe');
        }
        expect(user.exploration.sinceSecret).toBeGreaterThan(0);
    });
});

describe('surveying a region', () => {
    test('a fully charted region pays a standing bonus', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const settings = makeGuildSettings();
        const bare = getPayoutMultiplier(user, region, settings, 1, null);
        const progress = chartRegion(user, region);
        const surveyed = getPayoutMultiplier(user, region, settings, 1, progress);
        expect(surveyed / bare).toBeCloseTo(1 + LIMITS.SURVEY_BONUS, 10);
    });

    test('completing the last landmark fires the survey once', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const progress = chartRegion(user, region);
        progress.landmarksFound = region.landmarks.slice(1).map(l => l.id);
        expect(isRegionFullyCharted(region, progress)).toBe(false);

        // 0.3 lands the event roll on the discovery slot
        const result = withRandom(
            () => executeExplore(user, region, makeGuildSettings(), {}),
            () => 0.3,
        );

        expect(result.type).toBe('discovery');
        expect(result.regionCompleted).toBe(true);
        expect(progress.completedAt).toBeInstanceOf(Date);
        expect(user.exploration.regionsSurveyed).toBe(1);

        // A later expedition into the same region doesn't re-announce it
        user.exploration.stamina = LIMITS.MAX_STAMINA;
        const next = executeExplore(user, region, makeGuildSettings(), {});
        if (next.pendingChoice) resolveEncounter(user, region, makeGuildSettings(), next, 'observe');
        expect(next.regionCompleted).toBeUndefined();
        expect(user.exploration.regionsSurveyed).toBe(1);
    });
});

describe('exhausted slots still pay properly', () => {
    test('a fallback treasure caps at rare but keeps its relic roll', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const progress = chartRegion(user, region, { secrets: false });
        progress.landmarksFound = region.landmarks.map(l => l.id);

        // event roll → discovery · intro · tier roll (legendary) · line · amount
        // · relic check · relic pick
        const result = withRandom(
            () => executeExplore(user, region, makeGuildSettings(), {}),
            scriptRandom([0.3, 0.5, 0.99, 0.5, 0.5, 0, 0]),
        );

        expect(result.type).toBe('treasure');
        expect(result.fallbackTreasure).toBe(true);
        expect(result.treasureTier.tier).toBe('rare');
        expect(result.relic).toBeDefined();
        expect(user.exploration.relicsRecovered).toBe(1);
    });

    test('a normal treasure is still allowed to be legendary', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        // 0.6 lands the event roll on the treasure slot
        const result = withRandom(
            () => executeExplore(user, region, makeGuildSettings(), {}),
            scriptRandom([0.6, 0.5, 0.995, 0.5, 0.5, 0, 0]),
        );
        expect(result.type).toBe('treasure');
        expect(result.fallbackTreasure).toBe(false);
        expect(result.treasureTier.tier).toBe('legendary');
    });
});

describe('quiet expeditions', () => {
    test('cost the cooldown but not a stamina point', () => {
        const user = makeUser();
        const result = withRandom(
            () => executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {}),
            () => 0.999999,
        );
        expect(result.type).toBe('quiet');
        expect(result.staminaSpared).toBe(true);
        expect(user.exploration.stamina).toBe(LIMITS.MAX_STAMINA);
        expect(user.exploration.totalExpeditions).toBe(1);
        expect(user.exploration.lastExplore).toBeInstanceOf(Date);
    });

    test('a refund never pushes stamina over the cap', () => {
        const user = makeUser();
        user.exploration.stamina = LIMITS.MAX_STAMINA;
        withRandom(() => executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {}), () => 0.999999);
        expect(user.exploration.stamina).toBe(LIMITS.MAX_STAMINA);
    });
});

describe('relic collection', () => {
    test('every relic in the data tables is indexed with a value', () => {
        expect(RELIC_LIST.length).toBeGreaterThan(0);
        for (const relic of RELIC_LIST) {
            expect(getRelicMeta(relic.itemId)).toBe(RELIC_INDEX[relic.itemId]);
            expect(relic.value).toBeGreaterThan(0);
            expect(relic.regionName).toBeTruthy();
        }
    });

    test('every relic rarity is on the ladder, priced and iconned', () => {
        // An off-ladder rarity would fall through to value 0 and still raise the
        // collection bonus — a relic that pays a bonus and shows a price of zero.
        for (const relic of RELIC_LIST) {
            expect(RELIC_RARITY_ORDER).toContain(relic.rarity);
            expect(RELIC_VALUES[relic.rarity]).toBeGreaterThan(0);
            expect(RELIC_EMOJI[relic.rarity]).toBeTruthy();
        }
    });

    test('every region defines a relic pool, and a region without one still pays out', () => {
        for (const region of REGION_LIST) {
            expect(Array.isArray(region.relics)).toBe(true);
        }
        // Guard the future case: a hand-added region with no relics must degrade
        // to a plain treasure rather than throwing mid-expedition.
        const user = makeUser();
        const barren = { ...REGIONS.whispering_forest, id: 'barren_test', relics: undefined };
        const result = withRandom(
            () => executeExplore(user, barren, makeGuildSettings(), {}),
            scriptRandom([0.6, 0.5, 0.995, 0.5, 0.5, 0, 0]),
        );
        expect(result.type).toBe('treasure');
        expect(result.relic).toBeUndefined();
        expect(result.payout).toBeGreaterThan(0);
    });

    test('relic itemIds are unique across every region', () => {
        const ids = REGION_LIST.flatMap(r => (r.relics ?? []).map(x => x.itemId));
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('the bonus counts distinct relics, not duplicates', () => {
        const first = RELIC_LIST[0].itemId;
        const user = makeUser({ inventory: [{ itemId: first, quantity: 40 }] });
        expect(getRelicCollection(user)).toHaveLength(1);
        expect(getRelicBonus(user)).toBeCloseTo(LIMITS.RELIC_BONUS_PER, 10);
    });

    test('the bonus is capped and ignores non-relic inventory', () => {
        const user = makeUser({
            inventory: [
                ...RELIC_LIST.map(r => ({ itemId: r.itemId, quantity: 1 })),
                { itemId: 'lockpick', quantity: 9 },
            ],
        });
        expect(getRelicCollection(user)).toHaveLength(RELIC_LIST.length);
        expect(getRelicBonus(user)).toBe(LIMITS.RELIC_BONUS_MAX);
    });

    test('the collection bonus lifts payouts', () => {
        const region = REGIONS.whispering_forest;
        const settings = makeGuildSettings();
        const empty = makeUser();
        const collector = makeUser({ inventory: RELIC_LIST.slice(0, 5).map(r => ({ itemId: r.itemId, quantity: 1 })) });
        expect(getPayoutMultiplier(collector, region, settings, 1, null))
            .toBeGreaterThan(getPayoutMultiplier(empty, region, settings, 1, null));
    });

    test('treasure prefers relics the collector is missing', () => {
        const region = REGIONS.whispering_forest;
        const owned = region.relics[0];
        const user = makeUser({ inventory: [{ itemId: owned.itemId, quantity: 1 }] });
        // Legendary treasure: relicChance 1.0, whole regional pool eligible
        const result = withRandom(
            () => executeExplore(user, region, makeGuildSettings(), {}),
            scriptRandom([0.6, 0.5, 0.995, 0.5, 0.5, 0, 0]),
        );
        expect(result.relic.itemId).not.toBe(owned.itemId);
        expect(result.relicIsNew).toBe(true);
    });
});
