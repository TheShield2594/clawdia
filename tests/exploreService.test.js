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
    encounterLossBand,
    getEncounterStakes,
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

        // Both maxed their penalty roll, so each should land exactly on its own
        // encounter's ceiling — the generous settings must not have moved it.
        // (Whispering Forest's region multiplier is 1.0, so the band is the raw one.)
        expect(plainLoss.outcome).toBe('loss');
        expect(boostedLoss.outcome).toBe('loss');
        expect(plainLoss.penalty).toBe(encounterLossBand(plainLoss.encounter).max);
        expect(boostedLoss.penalty).toBe(encounterLossBand(boostedLoss.encounter).max);
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

    test('finding a secret puts the drought counter back to zero', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const settings = makeGuildSettings();
        user.exploration.stamina = LIMITS.MAX_STAMINA;
        user.exploration.sinceSecret = 7;

        // 0.92 is chosen to land in the secret slot of the region's event
        // table, so this expedition finds one rather than hoping a roll does.
        // The type assertion below is what keeps that honest: reorder or
        // reweight the table and it fails, instead of the test quietly
        // covering nothing. The twenty-expedition sweep below cannot stand in
        // for this — delete the reset and it still passes whenever those
        // twenty happen to turn up no secret at all.
        const roll = jest.spyOn(Math, 'random').mockReturnValue(0.92);
        try {
            const result = executeExplore(user, region, settings, {});
            expect(result.type).toBe('secret');
        } finally {
            roll.mockRestore();
        }

        expect(user.exploration.sinceSecret).toBe(0);
    });

    test('expeditions into a region with secrets left do build pity', () => {
        const user = makeUser();
        const region = REGIONS.whispering_forest;
        const settings = makeGuildSettings();

        // The counter holds "eligible expeditions since the last find", not
        // "expeditions so far": a find puts it back to zero, and runs into a
        // region with nothing left to uncover do not count at all. So it is
        // checked after every expedition rather than once at the end — one
        // run in twenty ends on the expedition that finds a secret, and a
        // closing assertion that the total is above zero fails on those
        // without anything being wrong.
        let expected = 0;
        let firstRun = null;

        for (let i = 0; i < 20; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;

            const r = executeExplore(user, region, settings, {});
            if (r.pendingChoice) resolveEncounter(user, region, settings, r, 'observe');
            firstRun ??= r;

            if (!r.secretsLeft) {
                // Nothing left to find here, so the counter must sit still.
            } else if (r.type === 'secret') {
                expected = 0;
            } else {
                expected += 1;
            }

            expect(user.exploration.sinceSecret).toBe(expected);
        }

        // The loop above says nothing if no expedition was ever eligible, and
        // a fresh region always is — so this is what keeps it honest.
        expect(firstRun.secretsLeft).toBe(true);
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

describe('explorer level-ups are reported, not swallowed', () => {
    test('an expedition that crosses a level records it on the result', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        // One XP short of Level 2, so any event type at all tips it over.
        user.exploration.xp = EXPLORER_LEVELS[1].xpRequired - 1;

        const result = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
        if (result.pendingChoice) {
            resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), result, 'observe');
        }

        expect(result.explorerLevelUp).toBeDefined();
        expect(result.explorerLevelUp.oldLevel).toBe(1);
        expect(result.explorerLevelUp.newLevel).toBe(user.exploration.level);
        expect(result.explorerLevelUp.newTitle).toBe(getLevelData(user.exploration.level).title);
    });

    test('an expedition that crosses no level records nothing', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();

        const result = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
        if (result.pendingChoice) {
            resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), result, 'observe');
        }

        expect(result.explorerLevelUp).toBeUndefined();
        expect(user.exploration.level).toBe(1);
    });

    test('a run that grants twice keeps the level it started at', () => {
        // Finishing a region pays the survey bonus on top of the event's own XP,
        // so the record has to span both grants rather than the last one only.
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        const region = REGIONS.whispering_forest;
        const progress = chartRegion(user, region, { lore: false });
        progress.loreFound = region.lore.slice(1).map(l => l.id);

        // Roll until the lore slot comes up — it is the only unfinished category
        // left, so finding it completes the survey in the same expedition. The
        // level is rewound before every attempt so the run that finally lands is
        // one XP short of Level 2, whatever the earlier attempts paid out.
        let result = null;
        for (let i = 0; i < 500 && !result; i++) {
            user.exploration.level = 1;
            user.exploration.xp = EXPLORER_LEVELS[1].xpRequired - 1;
            const candidate = executeExplore(user, region, makeGuildSettings(), {});
            if (candidate.regionCompleted) result = candidate;
            else if (candidate.pendingChoice) {
                resolveEncounter(user, region, makeGuildSettings(), candidate, 'observe');
            }
        }

        expect(result).not.toBeNull();
        expect(result.explorerLevelUp.oldLevel).toBe(1);
        expect(result.explorerLevelUp.newLevel).toBe(user.exploration.level);
        expect(user.exploration.level).toBeGreaterThan(1);
    });
});

describe('the daily cap ramps down instead of falling off', () => {
    test('the soft cap sits below the hard cap', () => {
        expect(LIMITS.DAILY_SOFT_CAP).toBeLessThan(LIMITS.DAILY_HARD_CAP);
        expect(LIMITS.DAILY_SOFT_CAP_RATE).toBeGreaterThan(0);
        expect(LIMITS.DAILY_SOFT_CAP_RATE).toBeLessThan(1);
    });

    test('below the soft cap a payout is paid in full', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();

        let paid = null;
        for (let i = 0; i < 400 && !paid; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
            if (r.payout > 0) paid = r;
        }

        expect(paid).not.toBeNull();
        expect(paid.payout).toBe(paid.grossPayout);
        expect(paid.softCapped).toBeUndefined();
        expect(paid.cappedByDailyCap).toBeUndefined();
    });

    test('between the caps a payout is trimmed to the soft rate, not to zero', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        user.exploration.dailyCoins = LIMITS.DAILY_SOFT_CAP;

        let trimmed = null;
        for (let i = 0; i < 400 && !trimmed; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
            if (r.payout > 0 && r.softCapped) trimmed = r;
        }

        expect(trimmed).not.toBeNull();
        expect(trimmed.payout).toBeGreaterThan(0);
        expect(trimmed.payout).toBeLessThan(trimmed.grossPayout);
        expect(trimmed.payout).toBe(Math.round(trimmed.grossPayout * LIMITS.DAILY_SOFT_CAP_RATE));
        expect(trimmed.hardCapped).toBeUndefined();
        expect(trimmed.cappedByDailyCap).toBe(true);
    });

    test('at the hard cap the coins stop and say so', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        user.exploration.dailyCoins = LIMITS.DAILY_HARD_CAP;

        let stopped = null;
        for (let i = 0; i < 400 && !stopped; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
            if (r.grossPayout > 0) stopped = r;
        }

        expect(stopped).not.toBeNull();
        expect(stopped.payout).toBe(0);
        expect(stopped.hardCapped).toBe(true);
        expect(stopped.cappedByDailyCap).toBe(true);
    });

    test('daily earnings never exceed the hard cap', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        user.exploration.dailyCoins = LIMITS.DAILY_HARD_CAP - 200;

        for (let i = 0; i < 200; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.starfall_wastes, makeGuildSettings(), {});
            if (r.pendingChoice) resolveEncounter(user, REGIONS.starfall_wastes, makeGuildSettings(), r, 'observe');
        }

        expect(user.exploration.dailyCoins).toBeLessThanOrEqual(LIMITS.DAILY_HARD_CAP);
    });
});

describe('approaching an encounter is a bet worth taking', () => {
    // The choice offered by /explore go is the only interactive decision in the
    // game. It is only a decision if bold actually pays better than careful —
    // otherwise the prompt is asking players to volunteer for a worse outcome.
    const safeRate = LIMITS.ENCOUNTER_SAFE_RATE;

    function expectedValues(region, enc) {
        const avgReward = (enc.reward.min + enc.reward.max) / 2;
        const band = encounterLossBand(enc);
        const avgLoss = (band.min + band.max) / 2;
        const m = region.payoutMultiplier;
        return {
            approach: enc.winChance * avgReward * m - (1 - enc.winChance) * avgLoss * m,
            observe:  avgReward * m * safeRate,
        };
    }

    test('every encounter in the game pays better for approaching', () => {
        const losers = [];
        for (const region of REGION_LIST) {
            for (const enc of region.encounters) {
                const { approach, observe } = expectedValues(region, enc);
                if (approach <= observe) losers.push(`${region.name} / ${enc.name}`);
            }
        }
        expect(losers).toEqual([]);
    });

    test('the margin is real but not a formality', () => {
        for (const region of REGION_LIST) {
            for (const enc of region.encounters) {
                const { approach, observe } = expectedValues(region, enc);
                const ratio = approach / observe;
                // Worth taking, without making "keep your distance" pointless.
                expect(ratio).toBeGreaterThan(1.2);
                expect(ratio).toBeLessThan(2);
            }
        }
    });

    test('losing is priced off what was on the table, not a flat fee', () => {
        // A flat penalty is what made the long-odds, big-prize encounters the
        // ones you should never take: the downside stayed put while the upside
        // grew, and "keep your distance" pays a share of that same upside.
        for (const region of REGION_LIST) {
            for (const enc of region.encounters) {
                const avgReward = (enc.reward.min + enc.reward.max) / 2;
                const band = encounterLossBand(enc);
                expect(band.min).toBeLessThan(band.max);
                // Rounding each end can shift the midpoint by half a coin.
                const mid = (band.min + band.max) / 2;
                expect(Math.abs(mid - avgReward * LIMITS.ENCOUNTER_LOSS_RATE)).toBeLessThanOrEqual(1);
            }
        }
    });

    test('a loss lands inside the encounter\'s own band', () => {
        const region = REGIONS.whispering_forest;
        const user = makeUser();
        let loss = null;
        for (let i = 0; i < 2_000 && !loss; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;
            const r = executeExplore(user, region, makeGuildSettings(), {});
            if (!r.pendingChoice) continue;
            const settled = resolveEncounter(user, region, makeGuildSettings(), r, 'approach');
            if (settled.outcome === 'loss') loss = settled;
        }
        expect(loss).not.toBeNull();
        const band = encounterLossBand(loss.encounter);
        expect(loss.penalty).toBeGreaterThanOrEqual(band.min);
        expect(loss.penalty).toBeLessThanOrEqual(band.max);
    });

    test('the prompt quotes the coins this player would actually see', () => {
        const region = REGIONS.crumbling_ruins;
        const settings = makeGuildSettings();
        // A relic case lifts payouts, so the quoted win band has to move with it.
        const plain = makeUser();
        const collector = makeUser({ inventory: RELIC_LIST.slice(0, 8).map(r => ({ itemId: r.itemId, quantity: 1 })) });

        const encounterFor = user => {
            for (let i = 0; i < 2_000; i++) {
                user.exploration.stamina = LIMITS.MAX_STAMINA;
                user.exploration.dailyCoins = 0;
                const r = executeExplore(user, region, settings, {});
                if (r.pendingChoice) return r;
            }
            throw new Error('no encounter rolled');
        };

        const plainResult = encounterFor(plain);
        const plainStakes = getEncounterStakes(plain, region, settings, plainResult);
        expect(plainStakes.winChance).toBe(plainResult.encounter.winChance);
        expect(plainStakes.win.min).toBeGreaterThan(plainStakes.safe.min);
        expect(plainStakes.safe.min).toBe(
            Math.round(plainResult.encounter.reward.min * region.payoutMultiplier * safeRate));

        // Same encounter definition, richer explorer → a bigger quoted prize.
        const richResult = encounterFor(collector);
        richResult.encounter = plainResult.encounter;
        const richStakes = getEncounterStakes(collector, region, settings, richResult);
        expect(richStakes.win.max).toBeGreaterThan(plainStakes.win.max);
        // The downside tracks region depth only, so generosity never inflates it.
        expect(richStakes.loss).toEqual(plainStakes.loss);
    });
});

describe('the map names the places you already paid to reach', () => {
    test('an unlocked but unentered region is named, not redacted', () => {
        const user = makeUser();
        user.exploration.unlockedRegions.push('crumbling_ruins');
        const text = renderMap(user, makeGuildSettings()).join('\n');
        expect(text).toContain('Crumbling Ruins');
        expect(text).toContain('route open — never entered');
    });

    test('a region still behind its level gate stays redacted', () => {
        const user = makeUser();
        const text = renderMap(user, makeGuildSettings()).join('\n');
        expect(text).not.toContain('Starfall Wastes');
        expect(text).toContain(`locked · Explorer Lv ${REGIONS.starfall_wastes.unlockLevel}`);
    });

    test('every locked region is still told apart by its own gate', () => {
        const user = makeUser();
        const gates = renderMap(user, makeGuildSettings())
            .filter(line => line.includes('???'))
            .map(line => line.slice(line.indexOf('locked')));
        expect(gates.length).toBeGreaterThan(1);
        expect(new Set(gates).size).toBe(gates.length);
    });
});

describe('the featured region rotation', () => {
    const { getDailyFeatured, FEATURED_REGIONS, FEATURED_PAYOUT_BONUS } = require('../src/data/featuredRotation');

    test('only ever features a region that exists and is always reachable', () => {
        for (const entry of FEATURED_REGIONS) {
            const region = REGIONS[entry.id];
            expect(region).toBeDefined();
            // Seasonal regions vanish with the calendar; featuring one would
            // advertise a bonus most of the server cannot collect.
            expect(region.seasonalEventId).toBeUndefined();
            expect(entry.name).toBe(region.name);
            expect(entry.emoji).toBe(region.emoji);
        }
    });

    test('every core region is in the rotation', () => {
        const core = REGION_LIST.filter(r => !r.seasonalEventId).map(r => r.id).sort();
        expect(FEATURED_REGIONS.map(r => r.id).sort()).toEqual(core);
    });

    test('the pick is stable for a guild and spread across guilds', () => {
        expect(getDailyFeatured('guild-a').region.id).toBe(getDailyFeatured('guild-a').region.id);
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(getDailyFeatured(`guild-${i}`).region.id);
        expect(seen.size).toBe(FEATURED_REGIONS.length);
    });

    test('the bonus rides the coin multiplier, so it lifts pay without raising the cost of failing', () => {
        // Folding it in anywhere else would mean a featured region also made
        // encounter losses and traps 25% more expensive.
        const region = REGIONS.whispering_forest;
        const user = makeUser();
        const settings = makeGuildSettings();
        const plain    = getPayoutMultiplier(user, region, settings, 1, null);
        const featured = getPayoutMultiplier(user, region, settings, 1 + FEATURED_PAYOUT_BONUS, null);
        expect(featured).toBeCloseTo(plain * (1 + FEATURED_PAYOUT_BONUS), 6);
        expect(getPenaltyMultiplier(region)).toBe(region.payoutMultiplier);
    });

    test('a featured haul is still bound by the daily cap', () => {
        const user = makeUser();
        user.exploration.dailyWindowStart = new Date();
        user.exploration.dailyCoins = LIMITS.DAILY_HARD_CAP;
        for (let i = 0; i < 60; i++) {
            user.exploration.stamina = LIMITS.MAX_STAMINA;
            const r = executeExplore(user, REGIONS.whispering_forest, makeGuildSettings(),
                { coinMultiplier: 1 + FEATURED_PAYOUT_BONUS });
            if (r.pendingChoice) resolveEncounter(user, REGIONS.whispering_forest, makeGuildSettings(), r, 'observe');
        }
        expect(user.exploration.dailyCoins).toBe(LIMITS.DAILY_HARD_CAP);
    });
});
