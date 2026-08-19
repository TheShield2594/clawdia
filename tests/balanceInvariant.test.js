'use strict';

// 41 source files mutate `balance`; before this file exactly one test asserted
// that it never goes negative, in exploreService.test.js. Every debit in the
// codebase is meant to be guarded — a `balance: { $gte: cost }` filter on the
// update, or a clamp against the current balance — and nothing proved those
// guards were still there.
//
// Two halves: the shared helper itself, then the helper driven across every
// payout and penalty path that can be run without a database. The grind and
// casino paths are RNG-driven, so each is sampled over many runs rather than by
// stubbing Math.random and coupling the test to the order of the roll calls.

const {
    expectNonNegativeBalance,
    expectNonNegativeBank,
    withBalanceInvariant,
    collectUsers,
} = require('./helpers/balanceInvariant');

const { executeHunt, ensureHuntData }    = require('../src/services/huntService');
const { executeCast, ensureFishingData } = require('../src/services/fishService');
const { executeMine, ensureMineData }    = require('../src/services/mineService');
const {
    executeExplore, resolveEncounter, ensureExploreData, applyDailyReset: exploreDailyReset,
} = require('../src/services/exploreService');

const { WEAPON_BY_TIER }  = require('../src/data/huntData');
const { ROD_BY_TIER }     = require('../src/data/fishData');
const { PICKAXE_BY_TIER } = require('../src/data/mineData');
const { REGIONS, LIMITS: EXPLORE_LIMITS } = require('../src/data/exploreData');

// ── The helper itself ────────────────────────────────────────────────────────

describe('balance invariant helper', () => {
    test('accepts a document with a non-negative balance', () => {
        expect(() => expectNonNegativeBalance({ userId: 'u1', balance: 0 })).not.toThrow();
        expect(() => expectNonNegativeBalance({ userId: 'u1', balance: 12_500 })).not.toThrow();
    });

    test('rejects a negative balance and names the user', () => {
        expect(() => expectNonNegativeBalance({ userId: 'u1', balance: -5 }, 'payout'))
            .toThrow(/payout: u1 balance=-5/);
    });

    test('rejects a balance that is not a finite number', () => {
        expect(() => expectNonNegativeBalance({ userId: 'u1', balance: NaN })).toThrow();
        expect(() => expectNonNegativeBalance({ userId: 'u1', balance: undefined })).toThrow();
    });

    test('walks a userId -> doc mock store, the shape most of these tests build', () => {
        const store = {
            robber: { userId: 'robber', balance: 100 },
            victim: { userId: 'victim', balance: -1 },
        };
        expect(() => expectNonNegativeBalance(store, 'rob')).toThrow(/rob: victim balance=-1/);
    });

    test('walks arrays and nested stores', () => {
        expect(collectUsers([{ balance: 1 }, { a: { balance: 2 } }])).toHaveLength(2);
        expect(() => expectNonNegativeBalance([{ userId: 'a', balance: 1 }, { userId: 'b', balance: -2 }]))
            .toThrow(/b balance=-2/);
    });

    test('fails rather than passing vacuously when nothing user-shaped is found', () => {
        expect(() => expectNonNegativeBalance({})).toThrow();
        expect(() => expectNonNegativeBalance([])).toThrow();
    });

    test('bank is checked when present and skipped when absent', () => {
        expect(() => expectNonNegativeBank({ userId: 'u1', balance: 0 })).not.toThrow();
        expect(() => expectNonNegativeBank({ userId: 'u1', balance: 0, bank: -3 }, 'withdraw'))
            .toThrow(/withdraw: u1 bank=-3/);
    });

    test('withBalanceInvariant still asserts when the wrapped call throws', async () => {
        const user = { userId: 'u1', balance: 10 };
        await expect(withBalanceInvariant(user, 'debit', async () => {
            user.balance -= 50;
            throw new Error('write failed');
        })).rejects.toThrow(/u1 balance=-40/);
    });

    test('withBalanceInvariant returns the wrapped value on success', async () => {
        const user = { userId: 'u1', balance: 10 };
        await expect(withBalanceInvariant(user, 'credit', async () => {
            user.balance += 5;
            return 'done';
        })).resolves.toBe('done');
    });
});

// ── Applied across the grind services ────────────────────────────────────────

function baseUser(overrides = {}) {
    return {
        userId: 'u1',
        guildId: 'g1',
        balance: 0,
        bank: 0,
        activeEffects: [],
        streak: { current: 0 },
        accountPrestige: { rank: 0 },
        quests: [],
        pets: [],
        inventory: [],
        markModified: () => {},
        ...overrides,
    };
}

/** Durability pools big enough that a long sample never breaks the gear mid-run. */
function gear(def) {
    return {
        currentDurability: 100_000, maxDurability: 100_000, baseDurability: 100_000,
        repairCount: 0, upgrade: null, status: 'good', tier: 1,
        name: def.name, slug: def.slug,
    };
}

// Starting at zero is the interesting case: any penalty path that debits without
// clamping to the balance on hand lands below zero on the very first failure.
const GRINDS = [
    {
        name: 'hunting',
        build: () => {
            const user = baseUser();
            ensureHuntData(user);
            user.hunt.stamina = 10_000;
            user.hunt.weapons = [gear(WEAPON_BY_TIER[1])];
            user.hunt.equippedWeaponIndex = 0;
            user.hunt.activeZone = 'murky_swamp';
            user.hunt.dailyWindowStart = new Date();
            return user;
        },
        act: user => executeHunt(user, 'murky_swamp'),
    },
    {
        name: 'fishing',
        build: () => {
            const user = baseUser();
            ensureFishingData(user);
            user.fishing.stamina = 10_000;
            user.fishing.rods = [gear(ROD_BY_TIER[1])];
            user.fishing.equippedRodIndex = 0;
            user.fishing.activeLocation = 'pond';
            user.fishing.dailyWindowStart = new Date();
            return user;
        },
        act: user => executeCast(user, 'pond'),
    },
    {
        name: 'mining',
        build: () => {
            const user = baseUser();
            ensureMineData(user);
            user.mining.stamina = 10_000;
            user.mining.pickaxes = [gear(PICKAXE_BY_TIER[1])];
            user.mining.equippedPickaxeIndex = 0;
            user.mining.activeDepth = 'surface_quarry';
            user.mining.dailyWindowStart = new Date();
            return user;
        },
        act: user => executeMine(user, 'surface_quarry'),
    },
];

describe.each(GRINDS)('$name: balance invariant across payouts and penalties', (grind) => {
    test('a broke player never goes negative, however the roll lands', () => {
        const user = grind.build();
        for (let i = 0; i < 3_000; i++) {
            user.balance = 0; // re-broke each run so every penalty debits from nothing
            grind.act(user);
            expectNonNegativeBalance(user, `${grind.name} run ${i}`);
        }
    });

    test('a funded player never goes negative over a long session', () => {
        const user = grind.build();
        user.balance = 1_000;
        for (let i = 0; i < 3_000; i++) {
            grind.act(user);
            expectNonNegativeBalance(user, `${grind.name} session run ${i}`);
        }
        // The session actually exercised payouts rather than only no-ops.
        expect(user.balance).not.toBe(1_000);
    });
});

// ── Applied across exploration, including the resolved-encounter branches ────

describe('exploring: balance invariant across every encounter choice', () => {
    const guildSettings = { economy: { enabled: true } };
    const CHOICES = ['observe', 'approach', 'flee', 'fight'];

    test.each(Object.keys(REGIONS))('%s never pushes a broke explorer negative', (regionId) => {
        const region = REGIONS[regionId];
        const user = baseUser();
        ensureExploreData(user);
        exploreDailyReset(user);

        for (let i = 0; i < 500; i++) {
            user.balance = 0;
            user.exploration.stamina = EXPLORE_LIMITS.MAX_STAMINA;
            user.exploration.dailyCoins = 0;

            const result = executeExplore(user, region, guildSettings, {});
            expectNonNegativeBalance(user, `explore ${regionId} run ${i}`);

            if (result.pendingChoice) {
                // Cycle the choices so the fight/flee penalty branches are all hit.
                resolveEncounter(user, region, guildSettings, result, CHOICES[i % CHOICES.length]);
                expectNonNegativeBalance(user, `explore ${regionId} resolve run ${i}`);
            }
        }
    });
});
