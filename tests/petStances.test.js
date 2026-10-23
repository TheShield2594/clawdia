'use strict';

/**
 * #1184 — stance rounds. How a stance matchup resolves, what its edge does to
 * a round, and that reading the opponent wins fights the stats alone would
 * lose. Seeded, so a failing rate can be looked at again.
 */

const {
    STANCES, STANCE_KEYS, STANCE_ROUNDS, STANCE_EXCHANGES, STANCE_WIN_MULT, STANCE_LOSE_MULT,
    stanceOutcome, randomStance, createBattle, runExchanges, battleVerdict, fightStanceRound,
    simulateStanceBattle, simulateBattle, stageForLevel,
} = require('../src/services/petService');

function seededRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), state | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pet = (level, personality = 'loyal', petId = 'dog') =>
    ({ petId, personality, level, evolutionStage: stageForLevel(level) });

function winRate(a, b, pickA, pickB, n = 2000, seed = 1184) {
    const rng = seededRng(seed);
    let wins = 0;
    for (let i = 0; i < n; i++) if (simulateStanceBattle(a, b, pickA, pickB, rng).winner === 'a') wins++;
    return wins / n;
}

describe('how stances resolve', () => {
    test.each([
        ['strike', 'trick', 'a'],
        ['trick', 'guard', 'a'],
        ['guard', 'strike', 'a'],
        ['trick', 'strike', 'b'],
        ['guard', 'trick', 'b'],
        ['strike', 'guard', 'b'],
    ])('%s against %s goes to %s', (a, b, winner) => {
        expect(stanceOutcome(a, b)).toBe(winner);
    });

    test('the same stance is a tie', () => {
        for (const key of STANCE_KEYS) expect(stanceOutcome(key, key)).toBeNull();
    });

    test('each stance beats exactly one other and loses to exactly one', () => {
        const beaten = STANCE_KEYS.map(k => STANCES[k].beats);
        expect(new Set(beaten)).toEqual(new Set(STANCE_KEYS));
        for (const k of STANCE_KEYS) expect(STANCES[k].beats).not.toBe(k);
    });

    test('a random stance is always a real one', () => {
        const rng = seededRng(7);
        for (let i = 0; i < 200; i++) expect(STANCES[randomStance(rng)]).toBeDefined();
        expect(randomStance(() => 0.9999999)).toBe('trick');
    });
});

describe('a stance round', () => {
    test('runs STANCE_EXCHANGES attacks, alternating, and scales both sides by the edge', () => {
        const neutral = () => 0.5; // no crit, no variance, no moves
        const plain = createBattle(pet(5), pet(5), neutral);
        const even = runExchanges(plain, STANCE_EXCHANGES, neutral);

        const read = createBattle(pet(5), pet(5), neutral);
        const { edge, rounds } = fightStanceRound(read, 'guard', 'strike', neutral);

        expect(edge).toBe('a');
        expect(rounds).toHaveLength(STANCE_EXCHANGES);
        expect(rounds.map(r => r.attacker)).toEqual(even.map(r => r.attacker));
        for (let i = 0; i < rounds.length; i++) {
            const want = rounds[i].attacker === 'a' ? STANCE_WIN_MULT : STANCE_LOSE_MULT;
            expect(rounds[i].damage).toBe(Math.max(1, Math.round(even[i].damage * want)));
        }
    });

    test('the edge lasts only for its own round', () => {
        const neutral = () => 0.5;
        const state = createBattle(pet(20), pet(20), neutral);
        fightStanceRound(state, 'trick', 'guard', neutral);
        const after = runExchanges(state, 2, neutral);

        const control = createBattle(pet(20), pet(20), neutral);
        const plain = runExchanges(control, 2, neutral);
        expect(after.map(r => r.damage)).toEqual(plain.map(r => r.damage));
    });

    test('a tie changes nothing: a battle of tied rounds is the plain simulation', () => {
        for (let seed = 1; seed <= 25; seed++) {
            const stance = simulateStanceBattle(pet(5), pet(5, 'energetic', 'cat'), () => 'guard', () => 'guard', seededRng(seed));
            const plain = simulateBattle(pet(5), pet(5, 'energetic', 'cat'), seededRng(seed));
            // The stance battle stops after STANCE_ROUNDS rounds; up to there the fights are the same.
            const n = STANCE_ROUNDS * STANCE_EXCHANGES;
            expect(stance.rounds).toEqual(plain.rounds.slice(0, n));
            if (plain.rounds.length <= n) expect(stance.winner).toBe(plain.winner);
        }
    });

    test('a fight that runs out of rounds goes to the higher HP fraction', () => {
        const state = createBattle(pet(30), pet(30), () => 0.5);
        state.a.hp = 10; state.b.hp = 200;
        expect(battleVerdict(state, () => 0.5).winner).toBe('b');
    });
});

describe('reading the opponent wins (#1184 "done when")', () => {
    const always = key => () => key;
    const counter = { strike: 'guard', guard: 'trick', trick: 'strike' };

    test('random stances on both sides leave an even matchup even', () => {
        const r = winRate(pet(10), pet(10), () => randomStance(), () => randomStance(), 3000);
        expect(r).toBeGreaterThan(0.44);
        expect(r).toBeLessThan(0.56);
    });

    test.each([5, 15, 30])('at Lv.%i, winning two of three reads takes nearly every even fight', level => {
        const r = winRate(pet(level), pet(level), round => (round < 2 ? counter.strike : 'strike'), always('strike'));
        expect(r).toBeGreaterThan(0.9);
    });

    test.each([5, 15, 30])('at Lv.%i, reading every round beats a pet a level stronger', level => {
        expect(winRate(pet(level), pet(level + 1), always('trick'), always('guard'))).toBeGreaterThan(0.85);
    });

    test('stats still count: being out-read by a pet five levels weaker does not lose at Lv.5', () => {
        expect(winRate(pet(10), pet(5), always('guard'), always('trick'))).toBeGreaterThan(0.95);
    });
});
