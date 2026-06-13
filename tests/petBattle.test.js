'use strict';

const {
    xpForLevel,
    stageForLevel,
    applyPetXp,
    getEffectiveBonusPct,
    getPetStats,
    simulateBattle,
    makeWildPet,
    getPetDisplay,
    PET_MAX_LEVEL,
} = require('../src/services/petService');

describe('pet XP curve', () => {
    test('level 1 needs no XP; curve is strictly increasing', () => {
        expect(xpForLevel(1)).toBe(0);
        for (let l = 2; l <= PET_MAX_LEVEL; l++) {
            expect(xpForLevel(l)).toBeGreaterThan(xpForLevel(l - 1));
        }
    });

    test('stage boundaries land at 10 and 20', () => {
        expect(stageForLevel(1)).toBe(1);
        expect(stageForLevel(9)).toBe(1);
        expect(stageForLevel(10)).toBe(2);
        expect(stageForLevel(19)).toBe(2);
        expect(stageForLevel(20)).toBe(3);
        expect(stageForLevel(30)).toBe(3);
    });
});

describe('applyPetXp', () => {
    test('levels up and evolves when crossing a stage boundary', () => {
        const pet = { petId: 'wolf', level: 1, xp: 0, evolutionStage: 1 };
        const res = applyPetXp(pet, xpForLevel(10));
        expect(pet.level).toBe(10);
        expect(pet.evolutionStage).toBe(2);
        expect(res.leveledUp).toBe(true);
        expect(res.evolved).toBe(true);
        expect(res.toStage).toBe(2);
    });

    test('does not exceed max level', () => {
        const pet = { petId: 'wolf', level: 1, xp: 0, evolutionStage: 1 };
        applyPetXp(pet, 10_000_000);
        expect(pet.level).toBe(PET_MAX_LEVEL);
        expect(pet.evolutionStage).toBe(3);
    });

    test('partial XP does not level when below threshold', () => {
        const pet = { petId: 'cat', level: 1, xp: 0, evolutionStage: 1 };
        const res = applyPetXp(pet, xpForLevel(2) - 1);
        expect(pet.level).toBe(1);
        expect(res.leveledUp).toBe(false);
    });
});

describe('getEffectiveBonusPct', () => {
    test('scales with level/stage but stays capped at 2.5x base', () => {
        const base = { petId: 'wolf', level: 1, evolutionStage: 1 }; // wolf base 10%
        expect(getEffectiveBonusPct(base)).toBe(10);

        const mid = { petId: 'wolf', level: 10, evolutionStage: 2 };
        const midPct = getEffectiveBonusPct(mid);
        expect(midPct).toBeGreaterThan(10);
        expect(midPct).toBeLessThanOrEqual(25);

        const maxed = { petId: 'wolf', level: 30, evolutionStage: 3 };
        expect(getEffectiveBonusPct(maxed)).toBe(25); // 10 * 2.5 cap
    });

    test('unknown pet contributes nothing', () => {
        expect(getEffectiveBonusPct({ petId: 'nope' })).toBe(0);
    });
});

describe('getPetStats', () => {
    test('a higher-level evolved pet is strictly stronger', () => {
        const weak   = getPetStats({ petId: 'cat', level: 1, evolutionStage: 1, personality: 'lazy' });
        const strong = getPetStats({ petId: 'cat', level: 20, evolutionStage: 3, personality: 'energetic' });
        expect(strong.hp).toBeGreaterThan(weak.hp);
        expect(strong.atk).toBeGreaterThan(weak.atk);
    });
});

describe('simulateBattle', () => {
    const fixedRng = () => 0.5; // no crits, neutral variance

    test('a vastly stronger pet reliably wins', () => {
        const strong = { petId: 'wolf', level: 25, evolutionStage: 3, personality: 'energetic' };
        const weak   = { petId: 'cat',  level: 1,  evolutionStage: 1, personality: 'lazy' };
        const res = simulateBattle(strong, weak, fixedRng);
        expect(res.winner).toBe('a');
        expect(res.rounds.length).toBeGreaterThan(0);
    });

    test('is deterministic for a fixed rng', () => {
        const a = { petId: 'fox', level: 8, evolutionStage: 1, personality: 'mischievous' };
        const b = { petId: 'dog', level: 7, evolutionStage: 1, personality: 'loyal' };
        const r1 = simulateBattle(a, b, fixedRng);
        const r2 = simulateBattle(a, b, fixedRng);
        expect(r1.winner).toBe(r2.winner);
        expect(r1.rounds.length).toBe(r2.rounds.length);
    });

    test('always produces a single winner', () => {
        for (let i = 0; i < 50; i++) {
            const lvlA = 1 + Math.floor(Math.random() * 30);
            const lvlB = 1 + Math.floor(Math.random() * 30);
            const a = { petId: 'wolf', level: lvlA, evolutionStage: 1, personality: 'energetic' };
            const b = { petId: 'cat',  level: lvlB, evolutionStage: 1, personality: 'loyal' };
            const res = simulateBattle(a, b);
            expect(['a', 'b']).toContain(res.winner);
        }
    });
});

describe('makeWildPet', () => {
    test('scales near the given level and is battle-ready', () => {
        const wild = makeWildPet(10, () => 0.5);
        expect(wild.level).toBeGreaterThanOrEqual(9);
        expect(wild.level).toBeLessThanOrEqual(12);
        expect(wild.hunger).toBe(100);
        expect(wild.wild).toBe(true);
    });
});

describe('getPetDisplay', () => {
    test('applies an evolution title at higher stages', () => {
        expect(getPetDisplay({ petId: 'wolf', name: 'Rex', evolutionStage: 1 }).titledName).toBe('Rex');
        expect(getPetDisplay({ petId: 'wolf', name: 'Rex', evolutionStage: 2 }).titledName).toBe('Seasoned Rex');
        expect(getPetDisplay({ petId: 'wolf', name: 'Rex', evolutionStage: 3 }).titledName).toBe('Apex Rex');
    });
});
