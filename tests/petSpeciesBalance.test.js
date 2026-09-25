'use strict';

/**
 * #1183. Species used to do nothing in a fight; each now has a signature move
 * (SPECIES_MOVES in services/petService.js) and the four rare pets a small
 * stat edge. This holds every pairing — shop, rare and wild, both seats, at
 * low, mid and high level — close to even, and the rare edge to what it
 * claims to be. It is split from petBattle.test.js only because it is the
 * slowest thing there.
 */

const {
    stageForLevel,
    simulateBattle,
    PET_DEFINITIONS,
    WILD_PET_IDS,
} = require('../src/services/petService');

/**
 * A deterministic stand-in for `Math.random`, seeded from a constant (#634).
 *
 * mulberry32: 32 bits of state and one multiply-xor round per call. It is not a
 * PRNG for anything that depends on the quality of its output, and it does not
 * need to be — the requirement is that the same seed produces the same sequence
 * on every machine and every run, so a case that fails can be looked at again.
 * `Math.random` is seedless by specification and cannot do that.
 */
function seededRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), state | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SPECIES = [...Object.keys(PET_DEFINITIONS), ...WILD_PET_IDS];
const isRare  = id => PET_DEFINITIONS[id]?.purchasable === false;

describe('species balance', () => {
    // The same shape as the personality test: every pairing, both seats, at
    // low, mid and high level. Shop and wild species stay within 42–58%; a
    // rare pet against a shop or wild one gets its stated edge, and is held
    // to it from both sides.
    test.each([1, 15, 28])('species pairings at level %i stay close to even, rare pets excepted to their edge', (level) => {
        const rng = seededRng(0x5BEC + level);
        const stage = stageForLevel(level);
        // 91 pairings a level, so a smaller N than the personality test to
        // keep the suite quick; the seed makes it the same 500 fights a
        // pairing on every run.
        const N = 250;
        let rareTotal = 0, rarePairs = 0;
        for (let i = 0; i < SPECIES.length; i++) {
            for (let j = i + 1; j < SPECIES.length; j++) {
                const x = SPECIES[i], y = SPECIES[j];
                let wins = 0;
                for (let k = 0; k < N; k++) {
                    const px = { petId: x, level, evolutionStage: stage, personality: 'loyal' };
                    const py = { petId: y, level, evolutionStage: stage, personality: 'loyal' };
                    if (simulateBattle(px, py, rng).winner === 'a') wins++;
                    if (simulateBattle(py, px, rng).winner === 'b') wins++;
                }
                const pct = wins / (2 * N);
                if (isRare(x) === isRare(y)) {
                    expect([x, y, pct > 0.42 && pct < 0.58]).toEqual([x, y, true]);
                } else {
                    const rarePct = isRare(x) ? pct : 1 - pct;
                    expect([x, y, rarePct > 0.45 && rarePct < 0.64]).toEqual([x, y, true]);
                    rareTotal += rarePct;
                    rarePairs += 1;
                }
            }
        }
        // The edge is felt: on average a rare pet wins more than half.
        expect(rareTotal / rarePairs).toBeGreaterThan(0.51);
    });

});
