'use strict';

// The /fish fight model: the reel-in on a rare-or-better bite and each round of
// a boss fight are the same read — a cue describing what the fish does, and the
// one move (reel / hold / slack) that answers it. What used to stand here was a
// single "press within 2s" button and three bosses whose every phase had the
// same answer, learnable once and never read again.

const {
    rollFightCues,
    scoreFightMove,
    rollBossFight,
    resolveBossPhases,
    resolveBossEncounter,
    rollFishWeight,
    recordLandedFish,
    castFatigueMult,
} = require('../src/services/fishService');
const {
    FIGHT_MOVES, FIGHT_CUES, BOSS_TYPES, BOSS_ROUNDS, BOSS_LINE_INTEGRITY, REEL_IN,
    FISH, FISH_WEIGHTS, SIZE_TIERS, LIMITS, FISH_WEIGHT_SCALE,
} = require('../src/data/fishData');
const { buildMoveRow, moveFromCustomId } = require('../src/commands/economy/fish/shared');

const cue = correct => ({ correct, text: FIGHT_CUES[correct][0] });

describe('fight cues', () => {
    test('every move has cues, and every cue answers to exactly one move', () => {
        const all = Object.values(FIGHT_CUES).flat();
        expect(Object.keys(FIGHT_CUES).sort()).toEqual(Object.keys(FIGHT_MOVES).sort());
        expect(new Set(all).size).toBe(all.length);
        for (const move of Object.keys(FIGHT_MOVES)) expect(FIGHT_CUES[move].length).toBeGreaterThanOrEqual(3);
    });

    test('a fight never shows the same cue twice', () => {
        for (let i = 0; i < 200; i++) {
            const cues = rollFightCues(3);
            expect(new Set(cues.map(c => c.text)).size).toBe(3);
            for (const c of cues) expect(FIGHT_CUES[c.correct]).toContain(c.text);
        }
    });

    test('a tendency biases the draw without fixing it', () => {
        const counts = { reel: 0, hold: 0, slack: 0 };
        for (let i = 0; i < 3000; i++) counts[rollFightCues(1, 'hold', 0.5)[0].correct] += 1;
        // 0.5 + 0.5/3 ≈ 67% hold; the others still come up.
        expect(counts.hold / 3000).toBeGreaterThan(0.6);
        expect(counts.reel).toBeGreaterThan(0);
        expect(counts.slack).toBeGreaterThan(0);
    });

    test('a wrong move costs its snap cost; a timeout costs one; the right move costs nothing', () => {
        expect(scoreFightMove(cue('hold'), 'hold')).toEqual({ correct: true, cost: 0 });
        expect(scoreFightMove(cue('hold'), 'reel')).toEqual({ correct: false, cost: FIGHT_MOVES.reel.snapCost });
        expect(scoreFightMove(cue('hold'), 'slack')).toEqual({ correct: false, cost: FIGHT_MOVES.slack.snapCost });
        expect(scoreFightMove(cue('hold'), 'timeout')).toEqual({ correct: false, cost: 1 });
    });

    test('the reel-in gives every rare-or-better tier a window long enough to read', () => {
        for (const cfg of Object.values(REEL_IN)) expect(cfg.windowMs).toBeGreaterThanOrEqual(4000);
        expect(REEL_IN.rare.required).toBe(false);
        expect(REEL_IN.legendary.beats).toBeGreaterThan(REEL_IN.epic.beats);
    });

    test('the move row always carries all three moves, and each id maps back', () => {
        const orders = new Set();
        for (let i = 0; i < 60; i++) {
            const ids = buildMoveRow(m => `reel_1_${m}`).toJSON().components.map(c => c.custom_id);
            expect(ids.map(moveFromCustomId).sort()).toEqual(Object.keys(FIGHT_MOVES).sort());
            orders.add(ids.join());
        }
        expect(orders.size).toBeGreaterThan(1);
    });
});

describe('boss fights', () => {
    test('every boss is fought for BOSS_ROUNDS rounds of cues', () => {
        for (let i = 0; i < 50; i++) {
            const { boss, rounds } = rollBossFight();
            expect(Object.values(BOSS_TYPES)).toContain(boss);
            expect(rounds).toHaveLength(BOSS_ROUNDS);
        }
    });

    test('no boss is a memorised answer: over many fights each one throws every move', () => {
        for (const boss of Object.values(BOSS_TYPES)) {
            const seen = new Set();
            for (let i = 0; i < 300; i++) rollFightCues(BOSS_ROUNDS, boss.tendency, boss.tendencyWeight).forEach(c => seen.add(c.correct));
            expect([boss.id, [...seen].sort()]).toEqual([boss.id, ['hold', 'reel', 'slack']]);
        }
    });

    test('line integrity matters: two reckless misreads snap the line even with a right read', () => {
        const rounds = [cue('hold'), cue('slack'), cue('reel')];
        const { phaseResults, lineIntegrity } = resolveBossPhases(rounds, ['hold', 'reel', 'hold']);
        expect(BOSS_LINE_INTEGRITY - FIGHT_MOVES.reel.snapCost - FIGHT_MOVES.hold.snapCost).toBeLessThanOrEqual(0);
        expect(lineIntegrity).toBe(0);
        expect(phaseResults.map(p => p.correct)).toEqual([true, false, false]);
    });

    test('the line snapping ends the fight: later answers are never scored', () => {
        const rounds = [cue('hold'), cue('hold'), cue('hold')];
        const { phaseResults } = resolveBossPhases(rounds, ['reel', 'reel', 'hold']);
        expect(phaseResults).toHaveLength(2);
    });

    test('a snapped line pays nothing whatever was read right', () => {
        const user = { fishing: { rods: [{ currentDurability: 50, maxDurability: 50, status: 'good' }], equippedRodIndex: 0 }, markModified: () => {} };
        const fight = { boss: BOSS_TYPES.leviathan, rounds: [cue('hold'), cue('slack'), cue('reel')] };
        const out = resolveBossEncounter(user, FISH.salmon, 'rare', ['hold', 'reel', 'hold'], fight);
        expect(out.lineSnapped).toBe(true);
        expect(out.outcome).toBe('escaped');
        expect(out.bonusPayout).toBe(0);
    });

    test('three right reads is a perfect fight', () => {
        const user = { fishing: { rods: [{ currentDurability: 50, maxDurability: 50, status: 'good' }], equippedRodIndex: 0 }, markModified: () => {} };
        const fight = { boss: BOSS_TYPES.ghost_eel, rounds: [cue('slack'), cue('reel'), cue('hold')] };
        const out = resolveBossEncounter(user, FISH.salmon, 'rare', ['slack', 'reel', 'hold'], fight);
        expect(out.outcome).toBe('perfect');
        expect(out.bonusPayout).toBeGreaterThan(0);
    });
});

describe('species weights', () => {
    test('a fish weighs within its own species range for its size', () => {
        const average = SIZE_TIERS.find(t => t.id === 'average');
        for (const [id, range] of Object.entries(FISH_WEIGHTS)) {
            for (let i = 0; i < 20; i++) {
                const w = rollFishWeight(FISH[id], average);
                expect(w).toBeGreaterThanOrEqual(Math.min(range.min, 0.01));
                expect(w).toBeLessThanOrEqual(range.max + 0.05);
            }
        }
    });

    test('a minnow never outweighs a great white', () => {
        const colossal = SIZE_TIERS.find(t => t.id === 'colossal');
        const tiny = SIZE_TIERS.find(t => t.id === 'tiny');
        expect(rollFishWeight(FISH.minnow, colossal)).toBeLessThan(rollFishWeight(FISH.great_white, tiny));
    });
});

describe('recordLandedFish — per-species personal bests', () => {
    const makeUser = () => ({ userId: 'u1', fishing: { catalog: {}, personalBest: null, weeklyRecord: null } });

    test('the first of a species is a first catch, not a personal best', () => {
        const user = makeUser();
        const out = recordLandedFish(user, FISH.bass, 4, 100, 'bob');
        expect(out).toMatchObject({ firstCatch: true, isPersonalBest: false, previousBest: 0 });
        expect(user.fishing.catalog.bass).toEqual({ count: 1, heaviest: 4, scale: FISH_WEIGHT_SCALE });
    });

    test('a heavier one of the same species is a personal best, a lighter one is not', () => {
        const user = makeUser();
        recordLandedFish(user, FISH.bass, 4, 100, 'bob');
        expect(recordLandedFish(user, FISH.bass, 3, 100, 'bob').isPersonalBest).toBe(false);
        const best = recordLandedFish(user, FISH.bass, 6, 100, 'bob');
        expect(best).toMatchObject({ isPersonalBest: true, previousBest: 4 });
    });

    test('a best weighed on the old per-tier table does not stand against the new weights', () => {
        const user = makeUser();
        user.fishing.catalog.bass = { count: 3, heaviest: 11.5 };   // no scale: old table
        const out = recordLandedFish(user, FISH.bass, 5, 100, 'bob');
        expect(out).toMatchObject({ firstCatch: false, isPersonalBest: true, previousBest: 0 });
        expect(user.fishing.catalog.bass).toEqual({ count: 4, heaviest: 5, scale: FISH_WEIGHT_SCALE });
    });
});

describe('cast fatigue', () => {
    test('the multiplier steps down at each diminishing-returns threshold', () => {
        expect(castFatigueMult(0)).toBe(1);
        expect(castFatigueMult(LIMITS.DIM_RETURNS_THRESHOLD_1)).toBe(0.85);
        expect(castFatigueMult(LIMITS.DIM_RETURNS_THRESHOLD_2)).toBe(0.70);
        expect(castFatigueMult(LIMITS.DIM_RETURNS_THRESHOLD_3)).toBe(0.55);
    });
});
