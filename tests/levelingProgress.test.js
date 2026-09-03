'use strict';

// #924: the dashboard's XP adjust route moved `xp` and left `level` alone, so a
// grant only turned into levels whenever the member next happened to speak. The
// fix needs the level rule in one place, callable outside a message handler —
// which is what `normalizeLevelProgress` is. These pin it against the loop it
// replaces, because the two have to agree exactly: they are the same rule, and
// a member's level must not depend on which of them last ran.

const { normalizeLevelProgress, xpToAdvance, applyXpGain } = require('../src/services/levelingService');

/** The catch-up loop as `applyXpGain` carried it, one level at a time. */
function byLoop(level, xp) {
    let [lvl, rem] = [level, xp];
    while (rem >= lvl * 100 + 100) {
        rem -= lvl * 100 + 100;
        lvl += 1;
    }
    return { level: lvl, xp: rem };
}

describe('xpToAdvance', () => {
    test('is 100 per level, starting at 100 for level 0', () => {
        expect([0, 1, 2, 9].map(xpToAdvance)).toEqual([100, 200, 300, 1000]);
    });
});

describe('normalizeLevelProgress', () => {
    test('leaves a pair that is already consistent alone', () => {
        expect(normalizeLevelProgress(3, 399)).toEqual({ level: 3, xp: 399 });
        expect(normalizeLevelProgress(0, 0)).toEqual({ level: 0, xp: 0 });
    });

    test('spends exactly one threshold at the boundary', () => {
        expect(normalizeLevelProgress(3, 400)).toEqual({ level: 4, xp: 0 });
        expect(normalizeLevelProgress(3, 401)).toEqual({ level: 4, xp: 1 });
    });

    test('crosses as many levels as the XP buys', () => {
        // From level 2: 300 to reach 3, then 400 to reach 4, leaving 60.
        expect(normalizeLevelProgress(2, 760)).toEqual({ level: 4, xp: 60 });
    });

    test('agrees with the one-level-at-a-time loop across the ordinary range', () => {
        const mismatches = [];
        for (let level = 0; level <= 40; level++) {
            for (let xp = 0; xp <= 4000; xp += 37) {
                const solved = normalizeLevelProgress(level, xp);
                const looped = byLoop(level, xp);
                if (solved.level !== looped.level || solved.xp !== looped.xp) {
                    mismatches.push({ level, xp, solved, looped });
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    // The dashboard's ceiling is 1e15 XP, which the loop spent about 4.5 million
    // iterations on. The solve has to land on the same answer there, where the
    // square root it uses is a float over an eighteen-digit discriminant.
    test('is exact at the dashboard ceiling, where the loop was millions of steps', () => {
        const MAX = 1_000_000_000_000_000;
        const { level, xp } = normalizeLevelProgress(0, MAX);

        // Cumulative cost of standing at (level, xp) is 50·level·(level+1) + xp.
        expect(50 * level * (level + 1) + xp).toBe(MAX);
        expect(xp).toBeLessThan(xpToAdvance(level));
        expect(xp).toBeGreaterThanOrEqual(0);
        expect(Number.isSafeInteger(level)).toBe(true);
    });

    test('never returns XP at or past the level it settles on', () => {
        for (const [level, xp] of [[0, 1], [0, 1e6], [7, 999_999], [1200, 5e8], [4_000_000, 1e12]]) {
            const settled = normalizeLevelProgress(level, xp);
            expect(settled.xp).toBeLessThan(xpToAdvance(settled.level));
            expect(settled.level).toBeGreaterThanOrEqual(level);
        }
    });

    test('treats a missing or negative pair as the start of level 0', () => {
        expect(normalizeLevelProgress(undefined, undefined)).toEqual({ level: 0, xp: 0 });
        expect(normalizeLevelProgress(-5, -20)).toEqual({ level: 0, xp: 0 });
    });
});

describe('applyXpGain over the shared rule', () => {
    test('still reports a promotion and leaves the member mid-level', () => {
        const user = { level: 2, xp: 40 };

        expect(applyXpGain(user, 300)).toMatchObject({ leveled: true, newLevel: 3, gained: 300 });
        expect(user).toMatchObject({ level: 3, xp: 40 });
    });

    test('reports no promotion when the gain stays inside the level', () => {
        const user = { level: 2, xp: 40 };

        expect(applyXpGain(user, 10)).toMatchObject({ leveled: false, newLevel: 2 });
        expect(user).toMatchObject({ level: 2, xp: 50 });
    });

    test('credits a member with neither field yet', () => {
        const user = {};

        expect(applyXpGain(user, 250)).toMatchObject({ leveled: true, newLevel: 1 });
        expect(user).toMatchObject({ level: 1, xp: 150 });
    });
});
