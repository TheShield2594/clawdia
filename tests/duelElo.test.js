const { tierFor, applyElo, softResetElo, RANK_TIERS, START_ELO } = require('../src/utils/duelElo');

describe('duelElo', () => {
    test('tierFor returns correct tier for boundary ELO values', () => {
        expect(tierFor(0).id).toBe('bronze');
        expect(tierFor(1099).id).toBe('bronze');
        expect(tierFor(1100).id).toBe('silver');
        expect(tierFor(1500).id).toBe('platinum');
        expect(tierFor(1899).id).toBe('diamond');
        expect(tierFor(1900).id).toBe('champion');
        expect(tierFor(5000).id).toBe('champion');
    });

    test('tierFor handles invalid input gracefully', () => {
        expect(tierFor(undefined).id).toBe('bronze');
        expect(tierFor(NaN).id).toBe('bronze');
        expect(tierFor(null).id).toBe('bronze');
    });

    test('applyElo: equal opponents trade roughly K/2', () => {
        const { winnerDelta, loserDelta } = applyElo(1500, 1500, 32);
        expect(winnerDelta).toBe(16);
        expect(loserDelta).toBe(-16);
    });

    test('applyElo: beating a higher-rated opponent yields more ELO than beating a lower-rated one', () => {
        const upset    = applyElo(1200, 1800, 32);
        const expected = applyElo(1800, 1200, 32);
        expect(upset.winnerDelta).toBeGreaterThan(expected.winnerDelta);
    });

    test('applyElo: loser cannot go below 0', () => {
        const { loserNewElo } = applyElo(2000, 5, 32);
        expect(loserNewElo).toBeGreaterThanOrEqual(0);
    });

    test('softResetElo pulls toward 1200', () => {
        expect(softResetElo(1800)).toBe(1500);
        expect(softResetElo(800)).toBe(1000);
        expect(softResetElo(1200)).toBe(1200);
    });

    test('RANK_TIERS form a contiguous ladder starting at 0', () => {
        expect(RANK_TIERS[0].min).toBe(0);
        for (let i = 0; i < RANK_TIERS.length - 1; i++) {
            expect(RANK_TIERS[i + 1].min).toBe(RANK_TIERS[i].max + 1);
        }
    });

    test('START_ELO maps to a known tier', () => {
        expect(tierFor(START_ELO).id).toBe('bronze');
    });
});
