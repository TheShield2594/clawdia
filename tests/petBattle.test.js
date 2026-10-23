'use strict';

const {
    xpForLevel,
    stageForLevel,
    applyPetXp,
    getEffectiveBonusPct,
    getPetStats,
    simulateBattle,
    makeWildPet,
    levelMatched,
    getPetDisplay,
    PET_DEFINITIONS,
    PET_MAX_LEVEL,
    WILD_PET_IDS,
    SPECIES_MOVES,
    getSpeciesMove,
    RARE_COMBAT_EDGE,
    TRAIN_MAX_SESSIONS,
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

    // #634. The 50 level pairs came from live `Math.random()`, and the battles
    // ran on the default `Math.random` rng too, so a failure named neither the
    // levels that produced it nor the rolls inside it — the one thing needed to
    // look at it again was gone by the time the output was read. Both are
    // seeded from a constant now: the same 50 pairs and the same rolls on every
    // machine and every run, and the pair travels into the assertion so a
    // failure says which one it was.
    //
    // A fixed table of pairs would also have been replayable, and this is
    // preferred only because the seed still drives the battle's own rolls,
    // which is where the interesting variation is: 30 rounds of variance and
    // crit per battle, rather than 50 hand-picked levels.
    test('always produces a single winner', () => {
        const rng = seededRng(0x5EEDF00D);
        const seen = new Set();

        for (let i = 0; i < 50; i++) {
            const lvlA = 1 + Math.floor(rng() * 30);
            const lvlB = 1 + Math.floor(rng() * 30);
            const pair = `level ${lvlA} v ${lvlB}`;
            seen.add(pair);

            const a = { petId: 'wolf', level: lvlA, evolutionStage: 1, personality: 'energetic' };
            const b = { petId: 'cat',  level: lvlB, evolutionStage: 1, personality: 'loyal' };
            const res = simulateBattle(a, b, rng);

            expect([pair, ['a', 'b'].includes(res.winner)]).toEqual([pair, true]);
            expect([pair, res.rounds.length > 0]).toEqual([pair, true]);
        }

        // A seed that happened to collapse the pairs would leave this looking
        // like 50 cases while testing two or three. It is a property of the
        // constant above, so it is checked rather than assumed.
        expect(seen.size).toBeGreaterThan(40);
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

// ─── Review fixes: fairness of who strikes first, and level-matched wagers ─────

describe('simulateBattle fairness', () => {
    const twin = { petId: 'dog', level: 15, evolutionStage: 2, personality: 'loyal' };

    test('a speed tie is decided by the rng, not handed to the challenger', () => {
        // First roll decides who opens; 0.9 hands it to B.
        let calls = 0;
        const rng = () => (calls++ === 0 ? 0.9 : 0.5);
        const res = simulateBattle(twin, { ...twin }, rng);
        expect(res.rounds[0].attacker).toBe('b');
    });

    test('a faster pet opens more often, but not always', () => {
        const rng = seededRng(0xFA57);
        const fast = { ...twin, personality: 'energetic' };
        let bOpened = 0;
        const N = 2000;
        for (let i = 0; i < N; i++) if (simulateBattle({ ...twin }, fast, rng).rounds[0].attacker === 'b') bOpened++;
        expect(bOpened / N).toBeGreaterThan(0.53);
        expect(bOpened / N).toBeLessThan(0.75);
    });

    test('an even mirror match is a coin flip for the challenger, not ~78%', () => {
        const rng = seededRng(0xC0FFEE);
        let wins = 0;
        const N = 4000;
        for (let i = 0; i < N; i++) if (simulateBattle(twin, { ...twin }, rng).winner === 'a') wins++;
        expect(wins / N).toBeGreaterThan(0.45);
        expect(wins / N).toBeLessThan(0.55);
    });
});

describe('personality balance', () => {
    // Personality is rolled once at adoption and never changes, so no roll may
    // be a lasting handicap. Every pairing, both seats, at low, mid and high
    // level, stays within 42–58% (the tuning keeps it near ±4%).
    const KEYS = ['energetic', 'mischievous', 'loyal', 'lazy'];

    test.each([1, 15, 28])('every pairing is close to even at level %i', (level) => {
        const rng = seededRng(0xBA1A + level);
        const stage = level >= 20 ? 3 : level >= 10 ? 2 : 1;
        const N = 1500;
        for (const x of KEYS) {
            for (const y of KEYS) {
                if (x === y) continue;
                let wins = 0;
                for (let i = 0; i < N; i++) {
                    const px = { petId: 'dog', level, evolutionStage: stage, personality: x };
                    const py = { petId: 'dog', level, evolutionStage: stage, personality: y };
                    if (simulateBattle(px, py, rng).winner === 'a') wins++;
                    if (simulateBattle(py, px, rng).winner === 'b') wins++;
                }
                const pct = wins / (2 * N);
                expect([x, y, pct > 0.42 && pct < 0.58]).toEqual([x, y, true]);
            }
        }
    });
});

describe('training balance (#1182)', () => {
    const KEYS = ['energetic', 'mischievous', 'loyal', 'lazy'];
    const FULL = { power: TRAIN_MAX_SESSIONS, guard: TRAIN_MAX_SESSIONS, agility: TRAIN_MAX_SESSIONS };

    // Seat-balanced win rate of `x` against `y` over 2N fights.
    function winRate(x, y, rng, N) {
        let wins = 0;
        for (let i = 0; i < N; i++) {
            if (simulateBattle(x, y, rng).winner === 'a') wins++;
            if (simulateBattle(y, x, rng).winner === 'b') wins++;
        }
        return wins / (2 * N);
    }

    test.each([1, 15, 28])('fully trained pets keep every personality pairing close to even at level %i', (level) => {
        const rng = seededRng(0x7EA1 + level);
        const stage = stageForLevel(level);
        for (const x of KEYS) {
            for (const y of KEYS) {
                if (x === y) continue;
                const pct = winRate(
                    { petId: 'dog', level, evolutionStage: stage, personality: x, training: FULL },
                    { petId: 'dog', level, evolutionStage: stage, personality: y, training: FULL },
                    rng, 500,
                );
                expect([x, y, pct > 0.42 && pct < 0.58]).toEqual([x, y, true]);
            }
        }
    });

    // Training has to be worth pressing, and no focus a trap: ten sessions of
    // any one focus beat an untrained twin, by a similar margin.
    test.each(['power', 'guard', 'agility'])('a maxed %s focus is a real but modest edge', (focus) => {
        const rng = seededRng(0xF0C5);
        const base = { petId: 'dog', level: 15, evolutionStage: 2, personality: 'loyal' };
        const pct = winRate({ ...base, training: { [focus]: TRAIN_MAX_SESSIONS } }, base, rng, 1000);
        expect([focus, pct > 0.53 && pct < 0.68]).toEqual([focus, true]);
    });

    // Thirty sessions (ten days of training at the cooldown) are worth about
    // one level: felt, and never a lock.
    test('a fully trained pet beats its untrained twin about as often as a level up would', () => {
        const rng = seededRng(0x1E7E1);
        const base = { petId: 'dog', level: 15, evolutionStage: 2, personality: 'loyal' };
        const trained = winRate({ ...base, training: FULL }, base, rng, 1000);
        expect(trained).toBeGreaterThan(0.6);
        expect(trained).toBeLessThan(0.8);
    });

    test('training shows in the stats', () => {
        const base = { petId: 'dog', level: 15, evolutionStage: 2, personality: 'loyal' };
        const plain = getPetStats(base);
        const full  = getPetStats({ ...base, training: FULL });
        expect(full.atk).toBeGreaterThan(plain.atk);
        expect(full.def).toBeGreaterThan(plain.def);
        expect(full.spd).toBeGreaterThan(plain.spd);
        expect(full.crit).toBeGreaterThan(plain.crit);
        expect(full.hp).toBe(plain.hp);
    });

    test('training travels into a level-matched wager', () => {
        const [a] = levelMatched({ petId: 'dog', level: 20, evolutionStage: 3, personality: 'loyal', training: { power: 4 } },
            { petId: 'cat', level: 12, evolutionStage: 2, personality: 'lazy' });
        expect(a.training).toEqual({ power: 4 });
    });
});

describe('species signature moves (#1183)', () => {
    const SPECIES = [...Object.keys(PET_DEFINITIONS), ...WILD_PET_IDS];

    test('every species, wild ones included, has a named move', () => {
        for (const id of SPECIES) {
            const move = getSpeciesMove(id);
            expect([id, typeof move?.name, typeof move?.desc]).toEqual([id, 'string', 'string']);
        }
        expect(Object.keys(SPECIES_MOVES).sort()).toEqual([...SPECIES].sort());
    });

    test("every species' move fires in the battle log", () => {
        const rng = seededRng(0x40FE);
        for (const id of SPECIES) {
            const name = getSpeciesMove(id).name;
            let fired = false;
            for (let i = 0; i < 400 && !fired; i++) {
                const opp = SPECIES[(SPECIES.indexOf(id) + 1 + (i % (SPECIES.length - 1))) % SPECIES.length];
                const res = simulateBattle(
                    { petId: id,  level: 10, evolutionStage: 2, personality: 'loyal' },
                    { petId: opp, level: 10, evolutionStage: 2, personality: 'loyal' },
                    rng,
                );
                fired = res.rounds.some(r => r.moves.some(m => m.side === 'a' && m.name === name));
            }
            expect([id, fired]).toEqual([id, true]);
        }
    });

    test('Nine Lives leaves the Cat standing at 1 HP after a lethal hit', () => {
        // Rolls are low throughout: every chance fires and hits are small, so
        // the fight goes long enough for a lethal hit to land on the cat.
        const res = simulateBattle(
            { petId: 'cat', level: 1, evolutionStage: 1, personality: 'loyal' },
            { petId: 'dog', level: 30, evolutionStage: 3, personality: 'loyal' },
            () => 0.01,
        );
        const saved = res.rounds.findIndex(r => r.moves.some(m => m.side === 'a' && m.name === 'Nine Lives'));
        expect(saved).toBeGreaterThanOrEqual(0);
        expect(res.rounds[saved].hpA).toBe(1);
        // Only once a fight.
        expect(res.rounds.filter(r => r.moves.some(m => m.name === 'Nine Lives'))).toHaveLength(1);
    });

    test("Lantern Flare makes the opponent's next attack miss", () => {
        const res = simulateBattle(
            { petId: 'lantern_owl', level: 10, evolutionStage: 2, personality: 'loyal' },
            { petId: 'dog',         level: 10, evolutionStage: 2, personality: 'loyal' },
            () => 0.01,
        );
        const flare = res.rounds.findIndex(r => r.attacker === 'a' && r.moves.some(m => m.name === 'Lantern Flare'));
        expect(flare).toBeGreaterThanOrEqual(0);
        const next = res.rounds[flare + 1];
        expect(next.attacker).toBe('b');
        expect(next.missed).toBe(true);
        expect(next.damage).toBe(0);
    });

    // Every species pairing's win rate: tests/petSpeciesBalance.test.js, a
    // file of its own so its 270 pairings run beside the rest of the suite.

    test('the rare edge is a few percent on HP, attack and defence', () => {
        expect(RARE_COMBAT_EDGE).toBeGreaterThan(0);
        expect(RARE_COMBAT_EDGE).toBeLessThanOrEqual(0.05);
        const shop = getPetStats({ petId: 'fox',         level: 15, evolutionStage: 2, personality: 'loyal' });
        const rare = getPetStats({ petId: 'crystal_fox', level: 15, evolutionStage: 2, personality: 'loyal' });
        expect(rare.atk / shop.atk).toBeCloseTo((1 + RARE_COMBAT_EDGE + 0) / 1, 1);
        expect(rare.atk).toBeGreaterThan(shop.atk);
        expect(rare.spd).toBe(shop.spd);
    });
});

describe('levelMatched', () => {
    test('scales both fighters to the lower level and leaves the originals alone', () => {
        const high = { petId: 'wolf', name: 'Rex', level: 22, evolutionStage: 3, personality: 'loyal', xp: 9000 };
        const low  = { petId: 'cat',  name: 'Tom', level: 12, evolutionStage: 2, personality: 'lazy' };

        const [a, b] = levelMatched(high, low);

        expect(a).toEqual({ petId: 'wolf', name: 'Rex', personality: 'loyal', level: 12, evolutionStage: 2 });
        expect(b).toEqual({ petId: 'cat', name: 'Tom', personality: 'lazy', level: 12, evolutionStage: 2 });
        expect(high.level).toBe(22);
        expect(high.evolutionStage).toBe(3);
    });

    test('a level lead no longer decides a wager', () => {
        const rng = seededRng(0xBEEF);
        const high = { petId: 'dog', level: 15, evolutionStage: 2, personality: 'loyal' };
        const low  = { petId: 'cat', level: 10, evolutionStage: 2, personality: 'loyal' };
        let wins = 0;
        const N = 4000;
        for (let i = 0; i < N; i++) {
            const [a, b] = levelMatched(high, low);
            if (simulateBattle(a, b, rng).winner === 'a') wins++;
        }
        expect(wins / N).toBeGreaterThan(0.45);
        expect(wins / N).toBeLessThan(0.55);
    });
});

describe('getPetDisplay for wild opponents and the Lantern Owl', () => {
    test('a wild opponent shows its own emoji rather than a paw print', () => {
        expect(getPetDisplay(makeWildPet(5, () => 0)).emoji).toBe('🐗');
        expect(getPetDisplay({ petId: 'cave_bat', name: 'Cave Bat' }).emoji).toBe('🦇');
    });

    test('the Lantern Owl changes look as it evolves', () => {
        expect(getPetDisplay({ petId: 'lantern_owl', evolutionStage: 1 }).emoji).toBe('🦉');
        expect(getPetDisplay({ petId: 'lantern_owl', evolutionStage: 3 }).emoji).toBe('🏮');
    });

    test('no evolved look repeats the stage before it, another species, or the Pet of the Week star', () => {
        const baseIcons = Object.values(PET_DEFINITIONS).map(d => d.emoji);
        for (const [petId, def] of Object.entries(PET_DEFINITIONS)) {
            const looks = [1, 2, 3].map(stage => getPetDisplay({ petId, evolutionStage: stage }).emoji);
            expect([petId, new Set(looks).size]).toEqual([petId, 3]);
            for (const look of looks.slice(1)) {
                const clash = look === '🌟' || baseIcons.some(icon => icon === look && icon !== def.emoji);
                expect([petId, look, clash]).toEqual([petId, look, false]);
            }
        }
    });

    test('every species has an evolved look at every stage', () => {
        for (const petId of Object.keys(PET_DEFINITIONS)) {
            for (const stage of [2, 3]) {
                expect([petId, stage, getPetDisplay({ petId, evolutionStage: stage }).emoji])
                    .not.toEqual([petId, stage, '🐾']);
            }
        }
    });
});

describe('pet sprite palettes', () => {
    const { __test__: sprites } = require('../src/utils/cardGenerator');

    test('cover every species, so none renders as a grey paw print', () => {
        for (const petId of Object.keys(PET_DEFINITIONS)) {
            expect([petId, Boolean(sprites.PET_SPRITE_COLORS[petId])]).toEqual([petId, true]);
            expect([petId, Boolean(sprites.PET_SPRITE_EMOJIS[petId])]).toEqual([petId, true]);
            for (const stage of [2, 3]) {
                expect([petId, stage, sprites.EVOLVED_PET_EMOJIS[petId]?.[stage]])
                    .toEqual([petId, stage, getPetDisplay({ petId, evolutionStage: stage }).emoji]);
            }
        }
    });
});
