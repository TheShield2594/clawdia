'use strict';

// Ascension (the level 30 endgame), the Hamster/Goat/Badger, the Curious and
// Stubborn personalities, and the codex and ascension achievements.

const {
    PET_DEFINITIONS,
    PET_MAX_LEVEL,
    PERSONALITY_KEYS,
    PERSONALITY_TRAITS,
    PERSONALITY_COMBAT,
    TRAIT_FLAVOR,
    SPECIES_ACTIONS,
    ASCENSION_MAX,
    ASCENSION_BONUS_PER_STAR,
    ASCENSION_STAR,
    createPet,
    petAscensions,
    ascensionStars,
    canAscend,
    ascendPet,
    getEffectiveBonusPct,
    getPetDisplay,
    getPetStats,
    stageForLevel,
    getTotalBonus,
    MAX_STACKED_BONUS_PCT,
    rarePetForSource,
    petCompanionLine,
} = require('../src/services/petService');
const { ACHIEVEMENTS, ALL_PET_IDS } = require('../src/data/achievements');
const { codexSummary } = require('../src/commands/economy/pet/codex');
const { __test__: { refusal, nextMaxPct } } = require('../src/commands/economy/pet/ascend');

const maxed = (over = {}) => ({
    ...createPet('wolf', { now: new Date() }),
    level: PET_MAX_LEVEL, evolutionStage: stageForLevel(PET_MAX_LEVEL), xp: 99_999,
    personality: 'loyal', bond: 40, battleWins: 12, training: { power: 3, guard: 0, agility: 0 },
    ...over,
});
const achievement = id => ACHIEVEMENTS.find(a => a.id === id);

describe('ascension', () => {
    test('only a level 30 pet with stars to spare can ascend', () => {
        expect(canAscend(maxed())).toEqual({ ok: true });
        expect(canAscend(maxed({ level: 29 }))).toEqual({ ok: false, reason: 'level' });
        expect(canAscend(maxed({ ascensions: ASCENSION_MAX }))).toEqual({ ok: false, reason: 'maxed' });
        const away = maxed({ vacationFrom: new Date(Date.now() - 1000), vacationUntil: new Date(Date.now() + 86_400_000) });
        expect(canAscend(away)).toEqual({ ok: false, reason: 'vacation' });
    });

    test('resets level, XP and stage, and keeps everything else', () => {
        const pet = maxed({ name: 'Rex', ladderTitle: 'S1 Ladder Champion' });
        const res = ascendPet(pet);
        expect(res.ascensions).toBe(1);
        expect(pet).toMatchObject({
            level: 1, xp: 0, evolutionStage: 1, ascensions: 1,
            name: 'Rex', personality: 'loyal', bond: 40, battleWins: 12,
            training: { power: 3 }, ladderTitle: 'S1 Ladder Champion',
        });
    });

    test('each star adds its share of the passive, on top of the level multiplier', () => {
        const before = getEffectiveBonusPct(maxed());
        const pet = maxed();
        const res = ascendPet(pet);
        expect(res.fromPct).toBe(before);
        expect(res.toPct).toBeLessThan(before);
        expect(res.maxPct).toBeCloseTo(before * (1 + ASCENSION_BONUS_PER_STAR), 0);
        expect(getEffectiveBonusPct(maxed({ ascensions: 3 }))).toBeCloseTo(before * (1 + 3 * ASCENSION_BONUS_PER_STAR), 0);
    });

    test('the stacking cap still holds for a three-star rare pet', () => {
        const owl = maxed({ petId: 'lantern_owl', ascensions: 3, hunger: 100 });
        expect(getEffectiveBonusPct(owl)).toBeGreaterThan(MAX_STACKED_BONUS_PCT);
        expect(getTotalBonus([owl], 'explore_xp')).toBe(MAX_STACKED_BONUS_PCT);
    });

    test('stars are not a battle stat', () => {
        expect(getPetStats(maxed({ ascensions: 3 }))).toEqual(getPetStats(maxed()));
    });

    test('stars show after the name, and an unascended pet looks as it always did', () => {
        expect(getPetDisplay(maxed({ name: 'Rex' })).titledName).toBe('Apex Rex');
        expect(getPetDisplay(maxed({ name: 'Rex', ascensions: 2 })).titledName).toBe(`Apex Rex ${ASCENSION_STAR}${ASCENSION_STAR}`);
        expect(ascensionStars({})).toBe('');
    });

    test('a bad stored count is read as a number in range', () => {
        expect(petAscensions({ ascensions: 'x' })).toBe(0);
        expect(petAscensions({ ascensions: -2 })).toBe(0);
        expect(petAscensions({ ascensions: 9 })).toBe(ASCENSION_MAX);
    });

    test('the command explains a refusal and previews the next star', () => {
        expect(refusal('level', 'Rex', { level: 12 })).toContain('level 12');
        expect(refusal('maxed', 'Rex', {})).toContain(`${ASCENSION_MAX}`);
        expect(refusal('vacation', 'Rex', {})).toContain('/pet vacation');
        const pet = maxed();
        expect(nextMaxPct(pet)).toBe(getEffectiveBonusPct(maxed({ ascensions: 1 })));
        expect(pet.ascensions ?? 0).toBe(0); // the preview does not mutate
    });
});

describe('the new species', () => {
    test.each(['hamster', 'goat', 'badger'])('%s is a shop pet with flavour, a gesture and a known food', (id) => {
        const def = PET_DEFINITIONS[id];
        expect(def.purchasable).toBe(true);
        expect(def.cost).toBeGreaterThan(0);
        expect(SPECIES_ACTIONS[id]).toEqual({ fed: expect.any(String), hungry: expect.any(String) });
        const { MATERIAL_RARITY } = require('../src/data/materialRarity');
        expect(MATERIAL_RARITY[def.favoriteMaterial]?.source).toBe(def.materialSource);
    });

    test('mining and exploring each gain a shop pet, weaker than their rare companion', () => {
        for (const [shop, source] of [['badger', 'mine'], ['goat', 'explore']]) {
            const rare = rarePetForSource(source);
            expect(PET_DEFINITIONS[shop].bonusType).toBe(rare.bonusType);
            expect(PET_DEFINITIONS[shop].bonusPct).toBeLessThan(rare.bonusPct);
        }
    });

    test('the Badger and Goat speak up on the activity they help', () => {
        const badger = { ...createPet('badger'), personality: 'curious' };
        const goat   = { ...createPet('goat'), personality: 'stubborn' };
        expect(petCompanionLine([goat, badger], 'mine')).toContain('Badger');
        expect(petCompanionLine([badger, goat], 'explore')).toContain('Goat');
    });
});

describe('the new personalities', () => {
    test.each(['curious', 'stubborn'])('%s has a label, a combat tilt and a line for every activity', (key) => {
        expect(PERSONALITY_KEYS).toContain(key);
        expect(PERSONALITY_TRAITS[key]).toEqual({ label: expect.any(String), emoji: expect.any(String), desc: expect.any(String) });
        expect(Object.keys(PERSONALITY_COMBAT[key]).length).toBeGreaterThan(0);
        for (const activity of ['hunt', 'fish', 'mine', 'explore']) {
            expect(TRAIT_FLAVOR[key][activity]('Rex', '🐶')).toContain('**Rex**');
        }
    });
});

describe('codex and ascension achievements', () => {
    test('the codex list is exactly the ownable species', () => {
        expect([...ALL_PET_IDS].sort()).toEqual(Object.keys(PET_DEFINITIONS).sort());
    });

    test('Zoologist counts the codex record, the roster and the memorial', () => {
        const z = achievement('zoologist');
        const [first, second, ...rest] = ALL_PET_IDS;
        const user = { petCodex: rest, pets: [{ petId: first }], deceasedPets: [] };
        expect(z.check(user)).toBe(false);
        expect(z.progress(user)).toEqual([ALL_PET_IDS.length - 1, ALL_PET_IDS.length]);
        user.deceasedPets.push({ petId: second });
        expect(z.check(user)).toBe(true);
    });

    test('Ascendant and Starbound read the best pet\'s stars', () => {
        const roster = n => ({ pets: [{ petId: 'dog' }, { petId: 'cat', ascensions: n }] });
        expect(achievement('ascendant').check(roster(0))).toBe(false);
        expect(achievement('ascendant').check(roster(1))).toBe(true);
        expect(achievement('starbound').check(roster(2))).toBe(false);
        expect(achievement('starbound').progress(roster(2))).toEqual([2, 3]);
        expect(achievement('starbound').check(roster(3))).toBe(true);
    });

    test('the codex headline names its reward until it is complete', () => {
        expect(codexSummary(4, 13)).toContain('Zoologist');
        expect(codexSummary(4, 13)).toContain('20,000');
        expect(codexSummary(13, 13)).toContain('complete');
    });
});
