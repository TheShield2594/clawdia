'use strict';

// #744 — the apex duel used to price itself from a fresh roll of the animal's
// base payout range, so every multiplier the kill had earned (crit, trophy
// quality, streak, the enraged trait) was thrown away, and the climax of a
// mythic crit paid like a consolation. It now scales off the kill it belongs to.

const {
    resolveApexEncounter,
    apexBasePayout,
    APEX_OUTCOME_RATE,
    buildApexEncounter,
    executeHunt,
    ensureHuntData,
    APEX_PHASES_PER_DUEL,
} = require('../src/services/huntService');
const { APEX_TYPES, ANIMALS_BY_TIER } = require('../src/data/huntData');

// A real legendary from the tables — the apex slot only opens on rare or better.
// Snow Leopard carries no 'armored' trait, so a pinned-low random still crits.
const LEGENDARY_ANIMAL = ANIMALS_BY_TIER.legendary.find(a => !a.traits?.includes('armored'));

const APEX = buildApexEncounter(APEX_TYPES.dire_alpha);
// A wide base range, so a re-roll would land on the pinned number essentially
// never — that is the whole point of the assertions below.
const ANIMAL = { payoutMin: 100, payoutMax: 2_000, name: 'Deer', emoji: '🦌' };

function choicesFor(pattern) {
    expect(pattern).toHaveLength(APEX_PHASES_PER_DUEL);
    return APEX.phases.map((phase, i) => {
        const c = pattern[i];
        if (c === 'C') return phase.correct;
        if (c === 'W') return phase.correct === 'match' ? 'hold' : 'match';
        return 'safe';
    });
}

function duel(pattern, options) {
    const user = { hunt: { equippedWeaponIndex: -1, weapons: [] }, markModified() {} };
    return resolveApexEncounter(user, ANIMAL, 'legendary', choicesFor(pattern), APEX, -1, options);
}

describe('apexBasePayout', () => {
    test('uses the kill payout when the duel has one to point at', () => {
        expect(apexBasePayout(ANIMAL, 12_345)).toBe(12_345);
    });

    test('falls back to the animal range for a duel with no kill behind it', () => {
        for (let i = 0; i < 50; i++) {
            const base = apexBasePayout(ANIMAL, undefined);
            expect(base).toBeGreaterThanOrEqual(ANIMAL.payoutMin);
            expect(base).toBeLessThanOrEqual(ANIMAL.payoutMax);
        }
    });

    test('ignores a kill payout that is not a usable number', () => {
        // A zero or missing payout is a kill that paid nothing (hard-capped, say);
        // pricing the duel at zero off it would silently delete the reward.
        for (const bad of [0, -50, null, NaN, 'lots']) {
            const base = apexBasePayout(ANIMAL, bad);
            expect(base).toBeGreaterThanOrEqual(ANIMAL.payoutMin);
            expect(base).toBeLessThanOrEqual(ANIMAL.payoutMax);
        }
    });
});

describe('the apex bonus scales off the kill', () => {
    test('each outcome pays its share of the kill payout, not a fresh roll', () => {
        const killPayout = 8_000; // far above the animal's own 100–2,000 band
        expect(duel('CCC', { killPayout }).bonusPayout)
            .toBe(Math.round(killPayout * APEX_OUTCOME_RATE.perfect));
        expect(duel('CCS', { killPayout }).bonusPayout)
            .toBe(Math.round(killPayout * APEX_OUTCOME_RATE.win));
        expect(duel('CSS', { killPayout }).bonusPayout)
            .toBe(Math.round(killPayout * APEX_OUTCOME_RATE.survived));
        expect(duel('SSS', { killPayout }).bonusPayout)
            .toBe(0); // no correct read at all — the apex escapes
    });

    test('a flawless duel out-earns the kill it grew out of', () => {
        // The framing is "the climax". A perfect three-phase duel that risks the
        // weapon must not pay less than the shot that preceded it.
        const killPayout = 4_000;
        expect(duel('CCC', { killPayout }).bonusPayout).toBeGreaterThan(killPayout);
    });

    test('two identical duels on identical kills pay identically', () => {
        // The old re-roll made the same duel pay differently run to run for no
        // reason a player could see.
        const payouts = new Set();
        for (let i = 0; i < 25; i++) {
            payouts.add(duel('CCC', { killPayout: 3_333 }).bonusPayout);
        }
        expect(payouts.size).toBe(1);
    });

    test('a better kill produces a better apex bonus', () => {
        const modest = duel('CCC', { killPayout: 1_000 }).bonusPayout;
        const mythic = duel('CCC', { killPayout: 10_000 }).bonusPayout;
        expect(mythic).toBeGreaterThan(modest * 9);
    });

    test('outcome tiers stay ordered against each other on one encounter', () => {
        const killPayout = 5_000;
        const perfect  = duel('CCC', { killPayout });
        const win      = duel('CCS', { killPayout });
        const survived = duel('CSS', { killPayout });
        expect([perfect.outcome, win.outcome, survived.outcome])
            .toEqual(['perfect', 'win', 'survived']);
        expect(perfect.bonusPayout).toBeGreaterThan(win.bonusPayout);
        expect(win.bonusPayout).toBeGreaterThan(survived.bonusPayout);
    });
});

describe('the hunt hands the duel its kill payout', () => {
    function hunter() {
        const user = {
            balance: 0,
            streak: { current: 0 },
            inventory: [],
            markModified() {},
        };
        ensureHuntData(user);
        Object.assign(user.hunt, {
            level: 50,
            stamina: 10,
            unlockedZones: ['beginner_forest'],
            activeZone: 'beginner_forest',
            weapons: [{ tier: 5, currentDurability: 500, maxDurability: 500, baseDurability: 500, upgrade: null }],
            equippedWeaponIndex: 0,
        });
        return user;
    }

    test('an apex encounter carries the kill payout the duel needs to price itself', () => {
        // Force a success, and force the apex roll, by pinning Math.random low.
        const realRandom = Math.random;
        Math.random = () => 0.001;
        try {
            // Pin the encounter to a legendary so the apex slot is even in play;
            // its 12% roll then always trips against a pinned-low random.
            const encounter = { tier: 'legendary', animal: LEGENDARY_ANIMAL };
            let found = null;
            for (let i = 0; i < 40 && !found; i++) {
                const user = hunter();
                const result = executeHunt(user, 'beginner_forest', { encounter });
                if (result.apexEncounter) found = result;
            }
            expect(found).not.toBeNull();
            expect(found.apexEncounter.killPayout).toBe(found.payoutBeforeMods);
            expect(found.apexEncounter.killPayout).toBeGreaterThan(0);
        } finally {
            Math.random = realRandom;
        }
    });

    test('payoutBeforeMods carries the kill multipliers, not just the base roll', () => {
        const user = hunter();
        user.streak.current = 30; // a streak multiplier the apex used to ignore
        const realRandom = Math.random;
        Math.random = () => 0.001; // success, and a crit
        try {
            const result = executeHunt(user, 'beginner_forest', {
                encounter: { tier: 'legendary', animal: LEGENDARY_ANIMAL },
            });
            expect(result.success).toBe(true);
            expect(result.payoutBeforeMods).toBeGreaterThan(result.rawPayout);
        } finally {
            Math.random = realRandom;
        }
    });
});
