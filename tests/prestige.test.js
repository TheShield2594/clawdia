const { tierFor, titleForExactRank, nextTierAfter, getBonusMultipliers, hasUnlock, badgeFor, roman, PRESTIGE_TIERS } = require('../src/utils/prestige');

describe('prestige', () => {
    test('tierFor returns floor of requested rank', () => {
        expect(tierFor(0).rank).toBe(0);
        expect(tierFor(1).rank).toBe(1);
        expect(tierFor(2).rank).toBe(2);
        expect(tierFor(5).rank).toBe(5);
        expect(tierFor(6).rank).toBe(6);  // P6 has its own explicit tier definition
        expect(tierFor(10).rank).toBe(10);
        expect(tierFor(15).rank).toBe(10); // above max defined tier
    });

    test('tierFor handles invalid input', () => {
        expect(tierFor(undefined).rank).toBe(0);
        expect(tierFor(-5).rank).toBe(0);
        expect(tierFor(NaN).rank).toBe(0);
    });

    test('nextTierAfter returns next explicit tier when defined', () => {
        expect(nextTierAfter(0).rank).toBe(1);
        expect(nextTierAfter(4).rank).toBe(5);
        expect(nextTierAfter(5).rank).toBe(6); // synthesized
        expect(nextTierAfter(9).rank).toBe(10);
    });

    test('getBonusMultipliers always returns ≥1.0', () => {
        const m = getBonusMultipliers(0);
        expect(m.yieldMult).toBe(1);
        expect(m.xpMult).toBe(1);

        const m3 = getBonusMultipliers(3);
        expect(m3.yieldMult).toBeGreaterThan(1);
        expect(m3.crimeSuccessMult).toBeGreaterThan(1);

        const m10 = getBonusMultipliers(10);
        expect(m10.yieldMult).toBeGreaterThan(m3.yieldMult);
    });

    test('hasUnlock follows the tier table', () => {
        expect(hasUnlock(0, 'black_market')).toBe(false);
        expect(hasUnlock(1, 'black_market')).toBe(true);
        expect(hasUnlock(2, 'legendary_zones')).toBe(true);
        expect(hasUnlock(10, 'ascended')).toBe(true);
        expect(hasUnlock(5, 'ascended')).toBe(false);
    });

    test('badgeFor renders rank visually', () => {
        expect(badgeFor(0)).toBe('');
        expect(badgeFor(3)).toBe('⟦P3⟧');
        expect(badgeFor(5)).toBe('⭐');
        expect(badgeFor(10)).toBe('✨');
    });

    test('roman converts integers correctly', () => {
        expect(roman(1)).toBe('I');
        expect(roman(4)).toBe('IV');
        expect(roman(9)).toBe('IX');
        expect(roman(50)).toBe('L');
        expect(roman(14)).toBe('XIV');
    });

    test('PRESTIGE_TIERS includes the required milestones from the issue', () => {
        const ranks = PRESTIGE_TIERS.map(t => t.rank);
        expect(ranks).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5, 10]));
    });

    test('titleForExactRank renders explicit tiers verbatim (P0-P10 all have their own entry)', () => {
        expect(titleForExactRank(0)).toBeNull();
        expect(titleForExactRank(1)).toBe('Prestige I');
        expect(titleForExactRank(5)).toBe('Prestige V ⭐');
        expect(titleForExactRank(6)).toBe('Prestige VI');
        expect(titleForExactRank(9)).toBe('Prestige IX 💠');
        expect(titleForExactRank(10)).toBe('The Ascended ✨');
    });

    test('titleForExactRank synthesizes a title beyond the max defined tier (P10)', () => {
        expect(titleForExactRank(11)).toBe('Prestige XI');
        expect(titleForExactRank(14)).toBe('Prestige XIV');
    });
});
