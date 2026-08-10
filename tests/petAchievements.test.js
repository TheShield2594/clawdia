'use strict';

const { ACHIEVEMENTS, CATEGORY_LABELS, CATEGORY_EMOJIS } = require('../src/data/achievements');

const petAchievements = ACHIEVEMENTS.filter(a => a.category === 'pets');
const byId = id => petAchievements.find(a => a.id === id);

const DAY = 86400000;
const pet = (over = {}) => ({ petId: 'dog', level: 1, evolutionStage: 1, battleWins: 0, adoptedAt: new Date(), ...over });

describe('pet achievements', () => {
    test('the category is registered for display', () => {
        expect(petAchievements.length).toBeGreaterThan(0);
        expect(CATEGORY_LABELS.pets).toBeDefined();
        expect(CATEGORY_EMOJIS.pets).toBeDefined();
    });

    test('ids are unique across the whole achievement set', () => {
        const ids = ACHIEVEMENTS.map(a => a.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('none of them throw on a user who has never touched the pet system', () => {
        for (const def of petAchievements) {
            for (const user of [{}, { pets: [] }, { pets: null }]) {
                expect(() => def.check(user)).not.toThrow();
                expect(() => def.progress(user)).not.toThrow();
                expect(def.check(user)).toBe(false);
            }
        }
    });

    test('progress never exceeds its own maximum', () => {
        const maxed = {
            pets: [pet({ level: 30, evolutionStage: 3, battleWins: 999, adoptedAt: new Date(Date.now() - 400 * DAY) })],
        };
        for (const def of petAchievements) {
            const [current, max] = def.progress(maxed);
            expect(current).toBeLessThanOrEqual(max);
            expect(current).toBeGreaterThanOrEqual(0);
        }
    });

    test('First Companion unlocks on the first adoption', () => {
        expect(byId('first_companion').check({ pets: [] })).toBe(false);
        expect(byId('first_companion').check({ pets: [pet()] })).toBe(true);
    });

    test('Full House needs three pets at once', () => {
        expect(byId('full_house').check({ pets: [pet(), pet()] })).toBe(false);
        expect(byId('full_house').check({ pets: [pet(), pet(), pet()] })).toBe(true);
    });

    test('Well Fed and Apex Companion track the best pet, not the first', () => {
        const roster = { pets: [pet({ level: 1 }), pet({ level: 12, evolutionStage: 2 })] };
        expect(byId('well_fed').check(roster)).toBe(true);
        expect(byId('apex_companion').check(roster)).toBe(false);

        roster.pets.push(pet({ level: 21, evolutionStage: 3 }));
        expect(byId('apex_companion').check(roster)).toBe(true);
    });

    test('Pet Champion sums wins across the whole roster', () => {
        const roster = { pets: [pet({ battleWins: 10 }), pet({ battleWins: 14 })] };
        expect(byId('pet_champion').check(roster)).toBe(false);
        expect(byId('pet_champion').progress(roster)).toEqual([24, 25]);

        roster.pets.push(pet({ battleWins: 1 }));
        expect(byId('pet_champion').check(roster)).toBe(true);
    });

    test('Inseparable needs a 30-day bond', () => {
        expect(byId('inseparable').check({ pets: [pet({ adoptedAt: new Date(Date.now() - 29 * DAY) })] })).toBe(false);
        expect(byId('inseparable').check({ pets: [pet({ adoptedAt: new Date(Date.now() - 31 * DAY) })] })).toBe(true);
    });

    test('Menagerie needs all three rare companions', () => {
        const owned = ids => ({ pets: ids.map(petId => pet({ petId })) });
        expect(byId('menagerie').check(owned(['eagle', 'shark']))).toBe(false);
        expect(byId('menagerie').progress(owned(['eagle', 'shark']))).toEqual([2, 3]);
        expect(byId('menagerie').check(owned(['eagle', 'shark', 'crystal_fox']))).toBe(true);
    });

    test('Menagerie is reachable — every rare pet can actually drop', () => {
        const { rarePetForSource } = require('../src/services/petService');
        for (const petId of ['eagle', 'shark', 'crystal_fox']) {
            const source = require('../src/services/petService').PET_DEFINITIONS[petId].materialSource;
            expect(rarePetForSource(source).petId).toBe(petId);
        }
    });
});
