'use strict';

// Expedition routes and trail-sense streaks: the per-trip choice of how to set
// out, and what a risky choice puts on the line besides coins.

const {
    ensureExploreData,
    buildEventWeights,
    executeExplore,
    resolveEncounter,
    getSecretOdds,
    getPayoutMultiplier,
    getEncounterStakes,
    getLiveStreak,
    getStreakBonus,
    resolveRoute,
} = require('../src/services/exploreService');
const { LIMITS, REGIONS, ROUTES, ROUTE_LIST, DEFAULT_ROUTE } = require('../src/data/exploreData');
const { __setRandomSourceForTests } = require('../src/utils/secureRandom');

const region = REGIONS.whispering_forest;
const settings = { exploration: { enabled: true, dropRateMultiplier: 1, rareEventBonus: 0, disabledRegions: [] } };

function makeUser() {
    const user = { balance: 1e9, inventory: [], pets: [], markModified: jest.fn() };
    ensureExploreData(user);
    user.exploration.stamina = 1e9;
    return user;
}

// A seeded generator, so the route comparison below is the same every run.
function mulberry32(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function withRandom(fn, rng) {
    __setRandomSourceForTests(rng);
    try { return fn(); } finally { __setRandomSourceForTests(null); }
}

// Force a specific event type by scripting the first roll to land in its slot.
function rollInto(type, route) {
    const w = buildEventWeights(region, settings, route);
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const [t, weight] of Object.entries(w)) {
        if (t === type) return (acc + weight / 2) / total;
        acc += weight;
    }
    throw new Error(`no ${type} slot`);
}

describe('routes', () => {
    test('every route is complete and the default exists', () => {
        expect(ROUTES[DEFAULT_ROUTE]).toBeDefined();
        for (const route of ROUTE_LIST) {
            expect(route.name).toBeTruthy();
            expect(route.emoji).toBeTruthy();
            expect(route.description).toBeTruthy();
            for (const type of Object.keys(route.weights)) expect(region.eventWeights).toHaveProperty(type);
        }
    });

    test('an unknown route falls back to the default', () => {
        expect(resolveRoute('nowhere')).toBe(ROUTES[DEFAULT_ROUTE]);
        expect(resolveRoute(undefined)).toBe(ROUTES[DEFAULT_ROUTE]);
    });

    test('each route reshapes the table the way it says', () => {
        const share = (route, type) => {
            const w = buildEventWeights(region, settings, route);
            return w[type] / Object.values(w).reduce((a, b) => a + b, 0);
        };
        const { trail, offpath, deep } = ROUTES;
        expect(share(trail, 'trap')).toBeLessThan(share(offpath, 'trap'));
        expect(share(offpath, 'trap')).toBeLessThan(share(deep, 'trap'));
        expect(share(offpath, 'discovery')).toBeGreaterThan(share(trail, 'discovery'));
        expect(share(offpath, 'lore')).toBeGreaterThan(share(deep, 'lore'));
        expect(share(deep, 'secret')).toBeGreaterThan(share(trail, 'secret'));
        expect(share(deep, 'treasure')).toBeGreaterThan(share(trail, 'treasure'));
    });

    test('the secret odds quoted for a route are the ones it rolls against', () => {
        const user = makeUser();
        const trail = getSecretOdds(user, region, null, settings, ROUTES.trail);
        const deep  = getSecretOdds(user, region, null, settings, ROUTES.deep);
        expect(deep.chance).toBeGreaterThan(trail.chance);
        const w = buildEventWeights(region, settings, ROUTES.deep);
        expect(deep.baseChance).toBeCloseTo(w.secret / Object.values(w).reduce((a, b) => a + b, 0));
    });

    test('the route rides the payout multiplier, and the choice is remembered', () => {
        const user = makeUser();
        const base = getPayoutMultiplier(user, region, settings, 1, null, null);
        expect(getPayoutMultiplier(user, region, settings, 1, null, ROUTES.deep)).toBeCloseTo(base * (1 + ROUTES.deep.payoutBonus));
        expect(getPayoutMultiplier(user, region, settings, 1, null, ROUTES.trail)).toBeCloseTo(base * (1 + ROUTES.trail.payoutBonus));

        expect(user.exploration.lastRoute).toBe(DEFAULT_ROUTE);
        const result = executeExplore(user, region, settings, { route: 'deep' });
        expect(result.route).toBe('deep');
        expect(user.exploration.lastRoute).toBe('deep');
        // No route given: the last one is taken again.
        expect(executeExplore(user, region, settings, {}).route).toBe('deep');
    });

    test('deep-wilds traps bite harder', () => {
        const trap = region.traps[0];
        const penaltyFor = routeId => {
            const user = makeUser();
            // Every roll after the event slot pins high: the priciest trap
            // penalty and a dodged injury.
            let first = true;
            const rng = () => {
                if (first) { first = false; return rollInto('trap', ROUTES[routeId]); }
                return 0.999999;
            };
            const r = withRandom(() => executeExplore(user, region, settings, { route: routeId }), rng);
            expect(r.type).toBe('trap');
            return { penalty: r.penalty, trap: r.trap };
        };
        const trail = penaltyFor('trail');
        const deep  = penaltyFor('deep');
        expect(trail.trap).toBe(deep.trap);
        expect(trail.penalty).toBe(region.traps[region.traps.length - 1].penalty.max);
        expect(deep.penalty).toBe(Math.round(trail.penalty * ROUTES.deep.trapPenaltyMult));
        expect(trap).toBeDefined();
    });

    test('no route is the best at everything', () => {
        // The whole point of the choice: each route wins on something and
        // loses on something else. Played out with a fixed seed.
        const stats = {};
        for (const route of ROUTE_LIST) {
            const s = { coins: 0, traps: 0, charting: 0 };
            withRandom(() => {
                for (let t = 0; t < 40; t++) {
                    const user = makeUser();
                    for (let i = 0; i < 100; i++) {
                        user.exploration.dailyCoins = 0;
                        const before = user.balance;
                        const r = executeExplore(user, region, settings, { route: route.id });
                        if (r.pendingChoice) resolveEncounter(user, region, settings, r, 'observe');
                        s.coins += user.balance - before;
                        if (r.type === 'trap') s.traps++;
                        if ((r.type === 'discovery' && r.landmark) || r.type === 'lore' || r.type === 'secret') s.charting++;
                    }
                }
            }, mulberry32(1234));
            stats[route.id] = s;
        }
        const { trail, offpath, deep } = stats;
        // Deep pays best and is the most dangerous.
        expect(deep.coins).toBeGreaterThan(trail.coins);
        expect(deep.coins).toBeGreaterThan(offpath.coins);
        expect(deep.traps).toBeGreaterThan(offpath.traps);
        // The trail is the safest and pays the least of trail/deep.
        expect(trail.traps).toBeLessThan(offpath.traps);
        // Off the path charts fastest.
        expect(offpath.charting).toBeGreaterThan(trail.charting);
        expect(offpath.charting).toBeGreaterThan(deep.charting);
    });
});

describe('streaks', () => {
    function runAs(user, type, { route = 'trail', choice = 'observe', rng = null } = {}) {
        let first = true;
        const script = rng ?? (() => {
            if (first) { first = false; return rollInto(type, ROUTES[route]); }
            return 0.5;
        });
        return withRandom(() => {
            const r = executeExplore(user, region, settings, { route });
            if (r.pendingChoice) resolveEncounter(user, region, settings, r, choice);
            return r;
        }, script);
    }

    test('a clean run adds one, a trap ends it', () => {
        const user = makeUser();
        runAs(user, 'treasure');
        runAs(user, 'quiet');
        expect(user.exploration.streak).toBe(2);
        expect(getLiveStreak(user)).toBe(2);

        const trap = runAs(user, 'trap');
        expect(trap.streakBroken).toBe(2);
        expect(user.exploration.streak).toBe(0);
        expect(user.exploration.bestStreak).toBe(2);
    });

    test('a lost encounter ends it; keeping your distance does not', () => {
        const user = makeUser();
        runAs(user, 'treasure');
        const safe = runAs(user, 'encounter', { choice: 'observe' });
        expect(safe.outcome).toBe('safe');
        expect(user.exploration.streak).toBe(2);

        // First roll lands on the encounter; every later roll at 0.999999
        // loses the approach and dodges the injury.
        let first = true;
        const lose = runAs(user, 'encounter', {
            choice: 'approach',
            rng: () => { if (first) { first = false; return rollInto('encounter', ROUTES.trail); } return 0.999999; },
        });
        expect(lose.outcome).toBe('loss');
        expect(lose.streakBroken).toBe(2);
        expect(user.exploration.streak).toBe(0);
    });

    test('the encounter prompt says what a loss would cost the streak', () => {
        const user = makeUser();
        runAs(user, 'treasure');
        runAs(user, 'treasure');
        let first = true;
        const pending = withRandom(
            () => executeExplore(user, region, settings, { route: 'trail' }),
            () => { if (first) { first = false; return rollInto('encounter', ROUTES.trail); } return 0.5; },
        );
        expect(pending.pendingChoice).toBe(true);
        expect(getEncounterStakes(user, region, settings, pending).streakAtRisk).toBe(2);
    });

    test('the bonus is capped, the count is not', () => {
        const user = makeUser();
        for (let i = 0; i < LIMITS.STREAK_MAX + 5; i++) runAs(user, 'treasure');
        expect(user.exploration.streak).toBe(LIMITS.STREAK_MAX + 5);
        expect(getStreakBonus(user)).toBeCloseTo(LIMITS.STREAK_MAX * LIMITS.STREAK_BONUS_PER);
    });

    test('the streak lifts the coins it is quoted as lifting', () => {
        const user = makeUser();
        const cold = getPayoutMultiplier(user, region, settings, 1, null, ROUTES.trail);
        for (let i = 0; i < 3; i++) runAs(user, 'treasure');
        user.exploration.regions = [];
        const warm = getPayoutMultiplier(user, region, settings, 1, null, ROUTES.trail);
        expect(warm).toBeCloseTo(cold * (1 + 3 * LIMITS.STREAK_BONUS_PER));

        const next = runAs(user, 'treasure');
        expect(next.streakBonus).toBeCloseTo(3 * LIMITS.STREAK_BONUS_PER);
    });

    test('a trail left cold resets before the next run is priced', () => {
        const user = makeUser();
        runAs(user, 'treasure');
        runAs(user, 'treasure');
        user.exploration.streakAt = new Date(Date.now() - LIMITS.STREAK_WINDOW_MS - 1_000);
        expect(getLiveStreak(user)).toBe(0);
        expect(getStreakBonus(user)).toBe(0);

        const next = runAs(user, 'treasure');
        expect(next.streakCooled).toBe(2);
        expect(next.streakBonus).toBe(0);
        expect(user.exploration.streak).toBe(1);
    });
});
