'use strict';

const {
    resolveApexEncounter,
    apexNerveAfter,
    APEX_NERVE_MAX,
    getRarePityThreshold,
    msUntilDailyReset,
    applyPayoutModifiers,
} = require('../src/services/huntService');
const { APEX_TYPES, ZONES, ZONE_LIST, LIMITS } = require('../src/data/huntData');

const APEX = APEX_TYPES.dire_alpha;   // strategy: 'match'
const ANIMAL = { payoutMin: 100, payoutMax: 100 };

function duel(choices) {
    const user = { hunt: { equippedWeaponIndex: -1, weapons: [] }, markModified() {} };
    return resolveApexEncounter(user, ANIMAL, 'legendary', choices, APEX, -1);
}

describe('apex nerve', () => {
    it('busts the duel on two misreads even when a phase landed', () => {
        // One correct read, two wrong aggressive reads: nerve is spent, so the
        // apex escapes despite the hit. This is the case that used to pay out.
        const result = duel(['match', 'hold', 'hold']);
        expect(result.correctCount).toBe(1);
        expect(result.outcome).toBe('escaped');
        expect(result.bonusPayout).toBe(0);
    });

    it('lets backing off preserve a partial reward', () => {
        // Same single correct read, but the hunter hedged instead of guessing
        // wrong a second time.
        const result = duel(['match', 'hold', 'safe']);
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
        const result = duel(['match', 'match', 'match']);
        expect(result.outcome).toBe('perfect');
        expect(apexNerveAfter(result.phaseResults)).toBe(APEX_NERVE_MAX);
    });

    it('reports zero nerve exactly when the duel was lost to misreads', () => {
        for (const choices of [['match', 'hold', 'hold'], ['hold', 'hold', 'match']]) {
            const result = duel(choices);
            expect(apexNerveAfter(result.phaseResults)).toBe(0);
            expect(result.outcome).toBe('escaped');
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
