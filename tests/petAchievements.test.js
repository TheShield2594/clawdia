'use strict';

const { ACHIEVEMENTS, CATEGORY_LABELS, CATEGORY_EMOJIS, RARE_COMPANION_IDS } = require('../src/data/achievements');

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

    test('Menagerie needs every rare companion', () => {
        const owned = ids => ({ pets: ids.map(petId => pet({ petId })) });
        const all   = RARE_COMPANION_IDS;
        const short = all.slice(0, -1);

        expect(byId('menagerie').check(owned(short))).toBe(false);
        expect(byId('menagerie').progress(owned(short))).toEqual([short.length, all.length]);
        expect(byId('menagerie').check(owned(all))).toBe(true);
        expect(byId('menagerie').progress(owned(all))).toEqual([all.length, all.length]);
    });

    // The Lantern Owl shipped (#753) while Menagerie still asked for three pets,
    // so an achievement that says "every rare companion" checked a subset of
    // them. Pinning the list to PET_DEFINITIONS makes the next one added fail
    // here instead of quietly repeating that.
    test('Menagerie tracks exactly the pets that cannot be bought', () => {
        const { PET_DEFINITIONS } = require('../src/services/petService');
        const unpurchasable = Object.values(PET_DEFINITIONS)
            .filter(d => !d.purchasable)
            .map(d => d.petId);
        expect([...RARE_COMPANION_IDS].sort()).toEqual([...unpurchasable].sort());
    });

    test('Menagerie is reachable — every rare pet can actually drop', () => {
        const { rarePetForSource, PET_DEFINITIONS } = require('../src/services/petService');
        for (const petId of RARE_COMPANION_IDS) {
            const source = PET_DEFINITIONS[petId].materialSource;
            expect(rarePetForSource(source).petId).toBe(petId);
        }
    });

    test('the Menagerie description names the companions it checks', () => {
        const { PET_DEFINITIONS } = require('../src/services/petService');
        const { description } = byId('menagerie');
        for (const petId of RARE_COMPANION_IDS) {
            expect(description).toContain(PET_DEFINITIONS[petId].name);
        }
    });
});
