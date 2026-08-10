'use strict';

const { executeHunt, ensureHuntData }       = require('../src/services/huntService');
const { executeCast, ensureFishingData }    = require('../src/services/fishService');
const { executeMine, ensureMineData }       = require('../src/services/mineService');

const { WEAPON_BY_TIER }   = require('../src/data/huntData');
const { ROD_BY_TIER }      = require('../src/data/fishData');
const { PICKAXE_BY_TIER }  = require('../src/data/mineData');

function baseUser() {
    return {
        balance: 0,
        activeEffects: [],
        streak: { current: 0 },
        accountPrestige: { rank: 0 },
        quests: [],
        pets: [],
        markModified: () => {},
    };
}

/** Big durability pools so a long sample never breaks the gear mid-run. */
function gear(def, extra = {}) {
    return {
        currentDurability: 100_000, maxDurability: 100_000, baseDurability: 100_000,
        repairCount: 0, upgrade: null, status: 'good', tier: 1,
        name: def.name, slug: def.slug, ...extra,
    };
}

/**
 * Each activity's mildest failure tier — the one that should now be free — plus
 * how to build a runnable user and take one action.
 */
const ACTIVITIES = [
    {
        name: 'hunting',
        mildest: 'clean_miss',
        staminaOf: u => u.hunt.stamina,
        failsOf:   u => u.hunt.consecutiveFails,
        build: () => {
            const user = baseUser();
            ensureHuntData(user);
            user.hunt.stamina = 10_000;
            user.hunt.weapons = [gear(WEAPON_BY_TIER[1])];
            user.hunt.equippedWeaponIndex = 0;
            user.hunt.activeZone = 'beginner_forest';
            user.hunt.dailyWindowStart = new Date();
            return user;
        },
        act: user => executeHunt(user, 'beginner_forest'),
    },
    {
        name: 'fishing',
        mildest: 'line_slack',
        staminaOf: u => u.fishing.stamina,
        failsOf:   u => u.fishing.consecutiveFails,
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
        mildest: 'clean_miss',
        staminaOf: u => u.mining.stamina,
        failsOf:   u => u.mining.consecutiveFails,
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

describe('hunting: stamina floor', () => {
    test('a venomous kill at one stamina cannot push the hunter below zero', () => {
        // /hunt start admits an attempt at exactly 1 stamina, and venomous prey
        // docks an extra point before the common per-hunt cost lands. Landing on
        // -1 makes /hunt profile throw building its stamina bar ('⚡'.repeat(-1)).
        const huntActivity = ACTIVITIES.find(a => a.name === 'hunting');
        let venomousKills = 0;
        let lowest = Infinity;

        for (let i = 0; i < 20_000; i++) {
            const user = huntActivity.build();
            user.hunt.stamina = 1;
            const result = executeHunt(user, 'murky_swamp'); // venomous prey lives here
            if (result.success && result.traits?.includes('venomous')) venomousKills++;
            lowest = Math.min(lowest, user.hunt.stamina);
        }

        expect(venomousKills).toBeGreaterThan(0); // the double-deduction path really ran
        expect(lowest).toBe(0);
        expect(() => '⚡'.repeat(lowest)).not.toThrow();
    });
});

/**
 * These paths are RNG-driven, so the rule is asserted across many runs rather
 * than by stubbing Math.random and coupling to the order of the roll calls.
 */
describe.each(ACTIVITIES)('$name: stamina cost of a failed attempt', (activity) => {
    const runs = [];

    beforeAll(() => {
        for (let i = 0; i < 800; i++) {
            const user   = activity.build();
            const before = activity.staminaOf(user);
            const result = activity.act(user);
            runs.push({
                spent:    before - activity.staminaOf(user),
                success:  result.success,
                severity: result.failure?.severity?.id ?? null,
                spared:   !!result.staminaSpared,
            });
        }
    });

    test('the sample covers the mildest tier, harsher tiers and successes', () => {
        expect(runs.some(r => r.severity === activity.mildest)).toBe(true);
        expect(runs.some(r => !r.success && r.severity !== activity.mildest)).toBe(true);
        expect(runs.some(r => r.success)).toBe(true);
    });

    test(`the mildest failure tier costs no stamina`, () => {
        const mild = runs.filter(r => r.severity === activity.mildest);
        for (const run of mild) {
            expect(run.spared).toBe(true);
            expect(run.spent).toBe(0);
        }
    });

    test('every harsher failure still costs a point', () => {
        const harsh = runs.filter(r => !r.success && r.severity !== activity.mildest);
        for (const run of harsh) {
            expect(run.spared).toBe(false);
            expect(run.spent).toBeGreaterThanOrEqual(1);
        }
    });

    test('a success still costs a point', () => {
        // Venomous prey / traits dock an extra point on top, so assert at least one.
        for (const run of runs.filter(r => r.success)) {
            expect(run.spared).toBe(false);
            expect(run.spent).toBeGreaterThanOrEqual(1);
        }
    });

    test('a free failure still wears the gear and advances the streak', () => {
        // Bounded rather than looping until a clean miss turns up: the tier fires
        // ~17-19% of the time, so 500 attempts is a certainty in practice, but a
        // renamed severity id should fail the run rather than hang it forever.
        const MAX_ATTEMPTS = 500;
        let user = null, result = null;

        for (let i = 0; i < MAX_ATTEMPTS && !result; i++) {
            const candidate = activity.build();
            const outcome   = activity.act(candidate);
            if (outcome.failure?.severity?.id === activity.mildest) {
                user   = candidate;
                result = outcome;
            }
        }

        expect(result).not.toBeNull();
        expect(result.durabilityLost).toBeGreaterThan(0);
        expect(result.staminaSpared).toBe(true);
        expect(activity.failsOf(user)).toBe(1);
    });
});
