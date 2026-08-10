'use strict';

const {
    PET_DEFINITIONS,
    RARE_PET_DROP_CHANCE,
    rarePetForSource,
    createPet,
    rollRarePet,
    tryGrantRarePet,
    PERSONALITY_KEYS,
    isPetActive,
} = require('../src/services/petService');

const { applyXpGain } = require('../src/utils/applyXpGain');

const alwaysHit  = () => 0;                        // below any drop chance
const alwaysMiss = () => 0.999;                    // above any drop chance

describe('rare pet sources', () => {
    test('every unpurchasable pet is reachable from exactly one grind system', () => {
        const rare = Object.values(PET_DEFINITIONS).filter(d => !d.purchasable);
        expect(rare.length).toBeGreaterThan(0);

        for (const def of rare) {
            expect(rarePetForSource(def.materialSource)).toEqual(def);
        }
        // No two rare pets share a source, or one would be unreachable.
        const sources = rare.map(d => d.materialSource);
        expect(new Set(sources).size).toBe(rare.length);
    });

    test('the documented sources map to the expected companions', () => {
        expect(rarePetForSource('hunt').petId).toBe('eagle');
        expect(rarePetForSource('fish').petId).toBe('shark');
        expect(rarePetForSource('mine').petId).toBe('crystal_fox');
        expect(rarePetForSource('nonsense')).toBeNull();
    });
});

describe('rollRarePet', () => {
    test('only legendary results can produce a drop', () => {
        for (const tier of ['common', 'uncommon', 'rare', 'epic', 'event']) {
            expect(rollRarePet([], 'hunt', tier, alwaysHit)).toBeNull();
        }
        expect(rollRarePet([], 'hunt', 'legendary', alwaysHit)).not.toBeNull();
    });

    test('respects the drop chance', () => {
        expect(rollRarePet([], 'hunt', 'legendary', alwaysMiss)).toBeNull();
        expect(rollRarePet([], 'hunt', 'legendary', () => RARE_PET_DROP_CHANCE - 0.001)).not.toBeNull();
        expect(rollRarePet([], 'hunt', 'legendary', () => RARE_PET_DROP_CHANCE)).toBeNull();
    });

    test('never offers a pet the player already owns', () => {
        const owned = [{ petId: 'eagle' }];
        expect(rollRarePet(owned, 'hunt', 'legendary', alwaysHit)).toBeNull();
        // ...but a different system's companion is still available.
        expect(rollRarePet(owned, 'fish', 'legendary', alwaysHit).petId).toBe('shark');
    });

    test('does not mutate the pets it is handed', () => {
        const pets = [];
        rollRarePet(pets, 'hunt', 'legendary', alwaysHit);
        expect(pets).toHaveLength(0);
    });
});

describe('tryGrantRarePet', () => {
    test('adds a fully-formed pet to the user on a hit', () => {
        const user = { pets: [] };
        const def  = tryGrantRarePet(user, 'mine', 'legendary', alwaysHit);

        expect(def.petId).toBe('crystal_fox');
        expect(user.pets).toHaveLength(1);

        const pet = user.pets[0];
        expect(pet.petId).toBe('crystal_fox');
        expect(pet.hunger).toBe(100);
        expect(pet.level).toBe(1);
        expect(pet.evolutionStage).toBe(1);
        expect(PERSONALITY_KEYS).toContain(pet.personality);
        // A dropped pet must start fed, not instantly starving.
        expect(isPetActive(pet)).toBe(true);
    });

    test('adds nothing on a miss', () => {
        const user = { pets: [] };
        expect(tryGrantRarePet(user, 'mine', 'legendary', alwaysMiss)).toBeNull();
        expect(user.pets).toHaveLength(0);
    });

    test('cannot hand out a duplicate', () => {
        const user = { pets: [] };
        tryGrantRarePet(user, 'fish', 'legendary', alwaysHit);
        expect(tryGrantRarePet(user, 'fish', 'legendary', alwaysHit)).toBeNull();
        expect(user.pets).toHaveLength(1);
    });
});

describe('createPet', () => {
    test('starts a pet at level 1, full hunger and an aligned decay cursor', () => {
        const now = new Date('2026-03-01T00:00:00Z');
        const pet = createPet('dog', { name: 'Biscuit', now });

        expect(pet).toMatchObject({
            petId: 'dog', name: 'Biscuit', hunger: 100,
            level: 1, xp: 0, evolutionStage: 1,
            battleWins: 0, battleLosses: 0,
            starving: false, starvingStartAt: null,
        });
        expect(pet.lastDecayAt).toBe(now);
        expect(pet.lastFed).toBe(now);
        expect(pet.adoptedAt).toBe(now);
    });

    test('defaults to an unnamed pet with a random personality', () => {
        const pet = createPet('cat');
        expect(pet.name).toBeNull();
        expect(PERSONALITY_KEYS).toContain(pet.personality);
    });
});

describe('xp_gain pet passive', () => {
    const fedBird = () => ({ petId: 'bird', hunger: 100, level: 1, evolutionStage: 1, lastDecayAt: new Date() });

    test('a fed Bird boosts levelling XP', () => {
        const plain = { xp: 0, level: 0, pets: [] };
        const withBird = { xp: 0, level: 0, pets: [fedBird()] };

        const a = applyXpGain(plain, 100);
        const b = applyXpGain(withBird, 100);

        expect(a.gained).toBe(100);
        expect(a.petBonusPct).toBe(0);
        expect(b.gained).toBe(110); // bird base bonus is 10%
        expect(b.petBonusPct).toBe(10);
        expect(withBird.xp).toBeGreaterThan(plain.xp);
    });

    test('a starving Bird grants nothing', () => {
        const starved = { xp: 0, level: 0, pets: [{ ...fedBird(), hunger: 5 }] };
        expect(applyXpGain(starved, 100).gained).toBe(100);
    });

    test('a pet with an unrelated bonus type does not touch XP', () => {
        const wolfOwner = { xp: 0, level: 0, pets: [{ petId: 'wolf', hunger: 100, lastDecayAt: new Date() }] };
        expect(applyXpGain(wolfOwner, 100).gained).toBe(100);
    });

    test('still level-ups correctly on the boosted amount', () => {
        const user = { xp: 0, level: 0, pets: [fedBird()] };
        const res = applyXpGain(user, 100); // 110 credited, level 0 needs 100
        expect(res.gained).toBe(110);
        expect(res.leveled).toBe(true);
        expect(user.level).toBe(1);
        expect(user.xp).toBe(10);
    });

    test('handles a user with no pets array at all', () => {
        const user = { xp: 0, level: 0 };
        expect(applyXpGain(user, 50).gained).toBe(50);
    });
});
