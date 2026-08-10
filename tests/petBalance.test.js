'use strict';

const {
    getTotalBonus,
    getEffectiveBonusPct,
    MAX_STACKED_BONUS_PCT,
    pickDefenderPet,
    petCapacity,
    countSlotPets,
    hasFreePetSlot,
    BASE_PET_SLOTS,
    MAX_SLOT_EXPANSIONS,
    PET_DEFINITIONS,
} = require('../src/services/petService');

const fed = (over = {}) => ({ hunger: 100, lastDecayAt: new Date(), level: 1, evolutionStage: 1, ...over });

describe('stacked bonus cap', () => {
    test('two maxed fish_yield pets no longer stack to 50%', () => {
        const pets = [
            fed({ petId: 'fish',  level: 30, evolutionStage: 3 }), // 12.5%
            fed({ petId: 'shark', level: 30, evolutionStage: 3 }), // 37.5%
        ];
        const uncapped = pets.reduce((sum, p) => sum + getEffectiveBonusPct(p), 0);
        expect(uncapped).toBe(50);
        expect(getTotalBonus(pets, 'fish_yield')).toBe(MAX_STACKED_BONUS_PCT);
    });

    test('the cap never penalises a single fully-invested pet', () => {
        // Every pet on its own must stay under the cap, or maxing one would be wasted.
        for (const def of Object.values(PET_DEFINITIONS)) {
            const maxed = fed({ petId: def.petId, level: 30, evolutionStage: 3 });
            expect(getEffectiveBonusPct(maxed)).toBeLessThanOrEqual(MAX_STACKED_BONUS_PCT);
            expect(getTotalBonus([maxed], def.bonusType)).toBe(getEffectiveBonusPct(maxed));
        }
    });

    test('unstacked totals are untouched', () => {
        expect(getTotalBonus([fed({ petId: 'wolf' })], 'hunt_yield')).toBe(10);
        expect(getTotalBonus([fed({ petId: 'wolf' })], 'fish_yield')).toBe(0);
    });
});

describe('pickDefenderPet', () => {
    test('fields the closest level match rather than whatever is first', () => {
        const pets = [
            fed({ petId: 'cat',  level: 1,  name: 'Kitten' }),
            fed({ petId: 'wolf', level: 24, name: 'Fang'   }),
            fed({ petId: 'dog',  level: 12, name: 'Biscuit' }),
        ];
        expect(pickDefenderPet(pets, 25).name).toBe('Fang');
        expect(pickDefenderPet(pets, 11).name).toBe('Biscuit');
        expect(pickDefenderPet(pets, 1).name).toBe('Kitten');
    });

    test('breaks ties toward the stronger pet', () => {
        const pets = [
            fed({ petId: 'cat',  level: 8,  name: 'Low'  }),
            fed({ petId: 'wolf', level: 12, name: 'High' }),
        ];
        expect(pickDefenderPet(pets, 10).name).toBe('High');
    });

    test('skips pets that are too hungry to fight', () => {
        const starved = { petId: 'wolf', level: 30, name: 'Starved', hunger: 0, lastDecayAt: new Date() };
        const ready   = fed({ petId: 'dog', level: 2, name: 'Ready' });
        expect(pickDefenderPet([starved, ready], 30).name).toBe('Ready');
    });

    test('returns nothing when no pet is battle-ready', () => {
        expect(pickDefenderPet([], 5)).toBeNull();
        expect(pickDefenderPet(undefined, 5)).toBeNull();
        expect(pickDefenderPet([{ petId: 'dog', hunger: 0, lastDecayAt: new Date() }], 5)).toBeNull();
    });
});

describe('pet slots', () => {
    const roster = ids => ids.map(petId => ({ petId }));

    test('starts at the base capacity and grows with expansions', () => {
        expect(petCapacity({ petSlots: 0 })).toBe(BASE_PET_SLOTS);
        expect(petCapacity({ petSlots: 2 })).toBe(BASE_PET_SLOTS + 2);
    });

    test('expansions beyond the maximum are ignored', () => {
        expect(petCapacity({ petSlots: 99 })).toBe(BASE_PET_SLOTS + MAX_SLOT_EXPANSIONS);
        expect(petCapacity({ petSlots: -5 })).toBe(BASE_PET_SLOTS);
        expect(petCapacity({})).toBe(BASE_PET_SLOTS);
    });

    test('rare companions do not consume a slot', () => {
        // They drop at most once each, so a full roster must never lock them out.
        const pets = roster(['dog', 'cat', 'wolf', 'eagle', 'shark', 'crystal_fox']);
        expect(countSlotPets(pets)).toBe(3);
        expect(hasFreePetSlot({ petSlots: 1, pets })).toBe(true);
    });

    test('a full roster blocks further adoption', () => {
        const pets = roster(['dog', 'cat', 'wolf']);
        expect(hasFreePetSlot({ petSlots: 0, pets })).toBe(false);
        expect(hasFreePetSlot({ petSlots: 1, pets })).toBe(true);
    });

    test('an over-capacity roster is grandfathered, not trimmed', () => {
        // Rosters built before the cap existed keep every pet; they just cannot grow.
        const pets = roster(['dog', 'cat', 'wolf', 'fox', 'bird']);
        expect(countSlotPets(pets)).toBe(5);
        expect(hasFreePetSlot({ petSlots: 0, pets })).toBe(false);
        expect(pets).toHaveLength(5);
    });
});
