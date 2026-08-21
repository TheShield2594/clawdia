'use strict';

// #750 — exploration was the only grind system whose progression simply stopped.
// Explorer Level ended at 30 and kept banking XP into a counter nothing read;
// the relic case paid for ten distinct relics out of twenty-five, so the back
// half of a completed collection was worth nothing but trade value; and unlike
// hunting, fishing and mining there was no prestige of any kind to reset into.
//
// These cover the ladder that answers it, and — as much as anything — that the
// ladder is actually reachable and its bonuses actually apply.

const {
    ensureExploreData,
    getMaxStamina,
    getExplorerPrestige,
    getExplorerTitle,
    canPrestige,
    getRelicBonus,
    getRelicBonusCap,
    getRelicCapacity,
    relicCapacityForBonus,
    getPayoutMultiplier,
    getSecretOdds,
    applyExplorerXp,
    xpToNextLevel,
} = require('../src/services/exploreService');
const {
    EXPLORER_LEVELS, EXPLORER_PRESTIGE, PRESTIGE_TITLES, LIMITS,
    RELIC_LIST, RELIC_INDEX, REGIONS,
    MAX_EXPLORER_LEVEL, MAX_EXPLORER_PRESTIGE,
} = require('../src/data/exploreData');

function explorer({ level = 1, prestige = 0, xp = 0, relics = 0 } = {}) {
    const user = { exploration: {}, inventory: [], balance: 0, markModified() {} };
    ensureExploreData(user);
    Object.assign(user.exploration, { level, prestige, xp });
    // Distinct relics, taken off the front of the real index.
    user.inventory = RELIC_LIST.slice(0, relics).map(r => ({ itemId: r.itemId, quantity: 1 }));
    return user;
}

/** What /explore prestige does to the profile when a wanderer ascends. */
function ascend(user) {
    user.exploration.prestige += 1;
    user.exploration.level = 1;
    user.exploration.xp = 0;
    return user;
}

describe('the ladder is reachable', () => {
    test('explorer level still tops out where the level table ends', () => {
        const user = explorer({ level: MAX_EXPLORER_LEVEL });
        expect(xpToNextLevel(MAX_EXPLORER_LEVEL, EXPLORER_LEVELS.at(-1).xpRequired)).toBeNull();
        expect(canPrestige(user).ok).toBe(true);
    });

    test('every rank in the bonus table can be climbed to', () => {
        const user = explorer({ level: MAX_EXPLORER_LEVEL });
        for (let rank = 1; rank <= MAX_EXPLORER_PRESTIGE; rank++) {
            user.exploration.level = MAX_EXPLORER_LEVEL;
            ascend(user);
            expect(user.exploration.prestige).toBe(rank);
            expect(user.exploration.level).toBe(1);
            expect(user.exploration.xp).toBe(0);
        }
        expect(canPrestige(user)).toMatchObject({ ok: false, reason: 'max_rank' });
    });

    test('an unmaxed explorer is told what blocks them, not just refused', () => {
        const state = canPrestige(explorer({ level: 12 }));
        expect(state).toMatchObject({ ok: false, reason: 'level_too_low', rank: 0, level: 12 });
    });

    test('a profile written before the field existed reads as rank 0', () => {
        const legacy = { exploration: { level: 30 }, inventory: [], markModified() {} };
        expect(getExplorerPrestige(legacy)).toBe(EXPLORER_PRESTIGE[0]);
        expect(canPrestige(legacy).ok).toBe(true);
    });

    test('a rank past the end of the table clamps rather than throwing', () => {
        const user = explorer({ prestige: 99 });
        expect(getExplorerPrestige(user)).toBe(EXPLORER_PRESTIGE[MAX_EXPLORER_PRESTIGE]);
    });
});

describe('the bonuses actually apply', () => {
    test('max stamina grows at the rank the table says it does', () => {
        for (let rank = 0; rank <= MAX_EXPLORER_PRESTIGE; rank++) {
            const expected = LIMITS.MAX_STAMINA + EXPLORER_PRESTIGE[rank].staminaBonus;
            expect(getMaxStamina(explorer({ prestige: rank }))).toBe(expected);
        }
    });

    test('payouts rise at the rank that grants a payout bonus', () => {
        const region = REGIONS.whispering_forest;
        const plain   = getPayoutMultiplier(explorer({ prestige: 1 }), region, {}, 1, null);
        const bonused = getPayoutMultiplier(explorer({ prestige: 2 }), region, {}, 1, null);
        expect(bonused / plain).toBeCloseTo(1 + EXPLORER_PRESTIGE[2].payoutBonus, 10);
    });

    test('the payout bonus never shrinks as the rank climbs', () => {
        const region = REGIONS.whispering_forest;
        let previous = 0;
        for (let rank = 0; rank <= MAX_EXPLORER_PRESTIGE; rank++) {
            const mult = getPayoutMultiplier(explorer({ prestige: rank }), region, {}, 1, null);
            expect(mult).toBeGreaterThanOrEqual(previous);
            previous = mult;
        }
    });

    test('the secret slot widens at the rank that grants it', () => {
        const region = REGIONS.whispering_forest;
        const progress = { landmarksFound: [], loreFound: [], secretsFound: [], expeditions: 0 };
        const plain   = getSecretOdds(explorer({ prestige: 3 }), region, progress);
        const bonused = getSecretOdds(explorer({ prestige: 4 }), region, progress);
        expect(bonused.baseChance).toBeGreaterThan(plain.baseChance);
    });

    test('the quoted secret odds are the odds the roll plays against', () => {
        // Quoting an unprestiged slot while rolling a prestiged one is the exact
        // bug the shared buildEventWeights helper exists to prevent.
        const region = REGIONS.whispering_forest;
        const progress = { landmarksFound: [], loreFound: [], secretsFound: [], expeditions: 0 };
        const odds = getSecretOdds(explorer({ prestige: MAX_EXPLORER_PRESTIGE }), region, progress);
        const expected = region.eventWeights.secret * (1 + EXPLORER_PRESTIGE[MAX_EXPLORER_PRESTIGE].secretBonus);
        const total = Object.entries(region.eventWeights)
            .reduce((sum, [type, w]) => sum + (type === 'secret' ? expected : w), 0);
        expect(odds.baseChance).toBeCloseTo(expected / total, 10);
    });

    test('a maxed rank does not exhaust a region that still has secrets', () => {
        const region = REGIONS.whispering_forest;
        const odds = getSecretOdds(explorer({ prestige: MAX_EXPLORER_PRESTIGE }), region,
            { landmarksFound: [], loreFound: [], secretsFound: [], expeditions: 0 });
        expect(odds.exhausted).toBe(false);
        expect(odds.chance).toBeGreaterThan(0);
        expect(odds.chance).toBeLessThan(1);
    });
});

describe('the relic case is what the ladder is for', () => {
    test('the base case pays for well under half the known relics', () => {
        // This is the dead end the ladder exists to open: 25 relics, 10 of them
        // worth anything mechanically.
        expect(relicCapacityForBonus(0)).toBe(10);
        expect(RELIC_LIST.length).toBe(25);
    });

    test('each rank widens the case, and the top rank opens it completely', () => {
        let previous = 0;
        for (let rank = 0; rank <= MAX_EXPLORER_PRESTIGE; rank++) {
            const capacity = getRelicCapacity(explorer({ prestige: rank }));
            expect(capacity).toBeGreaterThanOrEqual(previous);
            previous = capacity;
        }
        expect(getRelicCapacity(explorer({ prestige: MAX_EXPLORER_PRESTIGE }))).toBe(RELIC_LIST.length);
    });

    test('a full collection pays in full only at the top rank', () => {
        const full = RELIC_LIST.length;
        const p0 = getRelicBonus(explorer({ prestige: 0, relics: full }));
        const p5 = getRelicBonus(explorer({ prestige: MAX_EXPLORER_PRESTIGE, relics: full }));
        expect(p0).toBeCloseTo(LIMITS.RELIC_BONUS_MAX, 10);
        expect(p5).toBeCloseTo(full * LIMITS.RELIC_BONUS_PER, 10);
        expect(p5).toBeGreaterThan(p0);
    });

    test('the eleventh relic is worth nothing at rank 0 and something above it', () => {
        // The precise complaint in the issue: relics 11-25 were shelf decoration.
        const at10 = explorer({ prestige: 0, relics: 10 });
        const at11 = explorer({ prestige: 0, relics: 11 });
        expect(getRelicBonus(at11)).toBe(getRelicBonus(at10));

        const p1at10 = explorer({ prestige: 1, relics: 10 });
        const p1at11 = explorer({ prestige: 1, relics: 11 });
        expect(getRelicBonus(p1at11)).toBeGreaterThan(getRelicBonus(p1at10));
    });

    test('the bonus never exceeds the case it is capped by', () => {
        for (let rank = 0; rank <= MAX_EXPLORER_PRESTIGE; rank++) {
            const user = explorer({ prestige: rank, relics: RELIC_LIST.length });
            expect(getRelicBonus(user)).toBeLessThanOrEqual(getRelicBonusCap(user) + 1e-9);
        }
    });

    test('duplicates still do not stack', () => {
        const user = explorer({ prestige: MAX_EXPLORER_PRESTIGE });
        const [first] = RELIC_LIST;
        user.inventory = [{ itemId: first.itemId, quantity: 40 }];
        expect(getRelicBonus(user)).toBeCloseTo(LIMITS.RELIC_BONUS_PER, 10);
    });

    test('every relic in the list is one the case can recognise', () => {
        for (const relic of RELIC_LIST) expect(RELIC_INDEX[relic.itemId]).toBeTruthy();
    });
});

describe('an ascended explorer does not read as a beginner', () => {
    test('a reset explorer carries their prestige title, not "Doorstep Wanderer"', () => {
        const fresh  = explorer({ level: 1, prestige: 0 });
        const reborn = explorer({ level: 1, prestige: 2 });
        expect(getExplorerTitle(fresh)).toBe(EXPLORER_LEVELS[0].title);
        expect(getExplorerTitle(reborn)).toBe(PRESTIGE_TITLES[2]);
    });

    test('the level title takes back over once the ladder is re-climbed', () => {
        const maxed = explorer({ level: MAX_EXPLORER_LEVEL, prestige: 3 });
        expect(getExplorerTitle(maxed)).toBe(EXPLORER_LEVELS.at(-1).title);
    });

    test('rank 0 is unaffected at every level', () => {
        for (const row of EXPLORER_LEVELS) {
            expect(getExplorerTitle(explorer({ level: row.level, prestige: 0 }))).toBe(row.title);
        }
    });
});

describe('the XP that used to be discarded now goes somewhere', () => {
    test('a reset explorer climbs the same ladder again from zero', () => {
        const user = explorer({ level: MAX_EXPLORER_LEVEL, xp: EXPLORER_LEVELS.at(-1).xpRequired });
        ascend(user);
        expect(xpToNextLevel(user.exploration.level, user.exploration.xp))
            .toBe(EXPLORER_LEVELS[1].xpRequired);
        applyExplorerXp(user, EXPLORER_LEVELS.at(-1).xpRequired);
        expect(user.exploration.level).toBe(MAX_EXPLORER_LEVEL);
        expect(canPrestige(user).ok).toBe(true);
    });
});
