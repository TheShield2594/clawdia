'use strict';

const {
    resolveApexEncounter,
    apexNerveAfter,
    APEX_NERVE_MAX,
    APEX_PHASES_PER_DUEL,
    buildApexEncounter,
    rollApexType,
    getRarePityThreshold,
    msUntilDailyReset,
    applyPayoutModifiers,
} = require('../src/services/huntService');
const { APEX_TYPES, ZONES, ZONE_LIST, LIMITS } = require('../src/data/huntData');

// A concrete duel: three phases drawn from the pool, each with its own
// correct answer. Patterns spell one choice per phase: C = the phase's
// correct read, W = the wrong aggressive read (the other of match/hold),
// S = the safe hedge.
const APEX = buildApexEncounter(APEX_TYPES.dire_alpha);
const ANIMAL = { payoutMin: 100, payoutMax: 100 };

function choicesFor(pattern) {
    return APEX.phases.map((phase, i) => {
        const c = pattern[i];
        if (c === 'C') return phase.correct;
        if (c === 'W') return phase.correct === 'match' ? 'hold' : 'match';
        return 'safe';
    });
}

function duel(pattern) {
    const user = { hunt: { equippedWeaponIndex: -1, weapons: [] }, markModified() {} };
    return resolveApexEncounter(user, ANIMAL, 'legendary', choicesFor(pattern), APEX, -1);
}

describe('apex nerve', () => {
    it('busts the duel on two misreads even when a phase landed', () => {
        // One correct read, two wrong aggressive reads: nerve is spent, so the
        // apex escapes despite the hit. This is the case that used to pay out.
        const result = duel('CWW');
        expect(result.correctCount).toBe(1);
        expect(result.outcome).toBe('escaped');
        expect(result.bonusPayout).toBe(0);
    });

    it('lets backing off preserve a partial reward', () => {
        // Same single correct read, but the hunter hedged instead of guessing
        // wrong a second time.
        const result = duel('CWS');
        expect(result.correctCount).toBe(1);
        expect(result.outcome).toBe('survived');
        expect(result.bonusPayout).toBeGreaterThan(0);
    });

    it('never charges nerve for backing off', () => {
        const results = [
            { correct: false, chosen: 'safe' },
            { correct: false, chosen: 'safe' },
            { correct: false, chosen: 'safe' },
        ];
        expect(apexNerveAfter(results)).toBe(APEX_NERVE_MAX);
    });

    it('still rewards a flawless read', () => {
        const result = duel('CCC');
        expect(result.outcome).toBe('perfect');
        expect(apexNerveAfter(result.phaseResults)).toBe(APEX_NERVE_MAX);
    });

    it('reports zero nerve exactly when the duel was lost to misreads', () => {
        for (const pattern of ['CWW', 'WWC']) {
            const result = duel(pattern);
            expect(apexNerveAfter(result.phaseResults)).toBe(0);
            expect(result.outcome).toBe('escaped');
        }
    });
});

describe('apex phases carry a real read', () => {
    it('gives every apex a pool with both aggressive answers represented', () => {
        // A pool where every phase shares one correct answer is the old
        // one-fact-per-apex problem again with extra steps.
        for (const apex of Object.values(APEX_TYPES)) {
            const corrects = new Set(apex.phasePool.map(p => p.correct));
            expect(apex.phasePool.length).toBeGreaterThan(APEX_PHASES_PER_DUEL);
            expect(corrects.has('match')).toBe(true);
            expect(corrects.has('hold')).toBe(true);
        }
    });

    it('never makes the safe hedge the correct answer', () => {
        for (const apex of Object.values(APEX_TYPES)) {
            for (const phase of apex.phasePool) {
                expect(['match', 'hold']).toContain(phase.correct);
                expect(phase.choices.match).toBeDefined();
                expect(phase.choices.hold).toBeDefined();
                expect(phase.choices.safe).toBeDefined();
            }
        }
    });

    it('deals each duel a fresh hand of phases from the pool', () => {
        const base = APEX_TYPES.dire_alpha;
        const sequences = new Set();
        for (let i = 0; i < 100; i++) {
            const enc = buildApexEncounter(base);
            expect(enc.phases).toHaveLength(APEX_PHASES_PER_DUEL);
            for (const phase of enc.phases) expect(base.phasePool).toContain(phase);
            expect(new Set(enc.phases).size).toBe(APEX_PHASES_PER_DUEL);
            sequences.add(enc.phases.map(p => base.phasePool.indexOf(p)).join('-'));
        }
        // 5 phases drawn 3 at a time in order = 60 sequences; 100 duels
        // landing on one would mean the shuffle is not shuffling.
        expect(sequences.size).toBeGreaterThan(5);
    });

    it('rolls a playable encounter, not the shared base table', () => {
        const enc = rollApexType();
        expect(Array.isArray(enc.phases)).toBe(true);
        expect(enc.phases).toHaveLength(APEX_PHASES_PER_DUEL);
        // The instance must not alias the base object, or one duel's draw
        // would leak into every later duel of the same apex.
        for (const base of Object.values(APEX_TYPES)) {
            expect(enc).not.toBe(base);
            expect(base.phases).toBeUndefined();
        }
    });
});

describe('rare pity threshold', () => {
    it('is set explicitly for every zone', () => {
        for (const zone of ZONE_LIST) {
            expect(typeof zone.rarePity).toBe('number');
            expect(getRarePityThreshold(zone)).toBe(zone.rarePity);
        }
    });

    it('falls back to the global limit for a zone that sets none', () => {
        expect(getRarePityThreshold({})).toBe(LIMITS.RARE_PITY_GUARANTEE);
        expect(getRarePityThreshold(undefined)).toBe(LIMITS.RARE_PITY_GUARANTEE);
    });

    it('is reachable in every zone, not just the starter one', () => {
        // A dry streak should be a rare-but-real tail event wherever you hunt.
        // The flat 50 it replaced was a 1-in-10^16 event at Legendary Peaks.
        const SUCCESS_RATE = 0.75;
        for (const zone of ZONE_LIST) {
            const weights  = zone.tierWeights;
            const total    = Object.values(weights).reduce((a, b) => a + b, 0);
            const rarePlus = (weights.rare + weights.epic + weights.legendary + weights.event) / total;
            const pDry     = Math.pow(1 - SUCCESS_RATE * rarePlus, zone.rarePity);
            expect(1 / pDry).toBeLessThan(2000);
        }
    });

    it('gets stricter as zones get richer', () => {
        expect(ZONES.beginner_forest.rarePity).toBeGreaterThan(ZONES.desert_wastes.rarePity);
        expect(ZONES.desert_wastes.rarePity).toBeGreaterThan(ZONES.arctic_tundra.rarePity);
        expect(ZONES.murky_swamp.rarePity).toBeGreaterThan(ZONES.legendary_peaks.rarePity);
    });
});

describe('daily hard cap reporting', () => {
    function cappedUser() {
        return {
            balance: 0,
            hunt: {
                dailyCoins: LIMITS.DAILY_HARD_CAP + 1,
                dailyHunts: 0,
                prestige: 0,
                dailyWindowStart: new Date(Date.now() - 6 * 3600_000),
            },
        };
    }

    it('names what the kill was worth instead of paying zero silently', () => {
        const result = applyPayoutModifiers(cappedUser(), 4321, ZONES.beginner_forest);
        expect(result.cappedByHard).toBe(true);
        expect(result.adjustedPayout).toBe(0);
        expect(result.forfeitedPayout).toBe(4321);
    });

    it('reports the time left on the rolling window', () => {
        const h = cappedUser().hunt;
        const remaining = msUntilDailyReset(h);
        expect(remaining).toBeGreaterThan(17 * 3600_000);
        expect(remaining).toBeLessThanOrEqual(18 * 3600_000);
    });

    it('reports no wait for a window that has not started', () => {
        expect(msUntilDailyReset({ dailyWindowStart: null })).toBe(0);
        expect(msUntilDailyReset(undefined)).toBe(0);
    });
});
