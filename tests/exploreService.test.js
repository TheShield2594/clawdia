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
    getAvailableRegions,
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
    TOTAL_CORE_SECRETS,
    EXPLORER_LEVELS,
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

describe('exploreData integrity', () => {
    test('has 4 core and 5 seasonal regions', () => {
        const core = REGION_LIST.filter(r => !r.seasonalEventId);
        const seasonal = REGION_LIST.filter(r => r.seasonalEventId);
        expect(core).toHaveLength(4);
        expect(seasonal).toHaveLength(5);

        const arcticTundra = REGION_LIST.find(r => r.id === 'arctic_tundra');
        expect(arcticTundra).toBeDefined();
        expect(arcticTundra.seasonalEventId).toBe('winter_hunt');
    });

    test('core regions hold 16 secrets total (matches achievement target)', () => {
        expect(TOTAL_CORE_SECRETS).toBe(16);
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
        const result = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
        if (result.pendingChoice) {
            resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), result, 'observe');
        }
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
});
