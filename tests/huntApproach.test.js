'use strict';

// The stealth approach used to be a knowledge check: ZONE_APPROACHES hardcoded
// one permanently-correct answer per zone, and the hint described a deer the
// player would never actually meet because the animal was rolled after the
// prompt. Now the encounter is rolled first, the hint names the real animal,
// and the correct approach follows that animal's traits (#739).

const {
    APPROACH_PROFILES,
    TRAIT_PROFILE_ORDER,
    GENERIC_PROFILE_IDS,
    pickApproachProfile,
} = require('../src/commands/economy/hunt').__test__;
const { rollHuntEncounter, executeHunt, ensureHuntData } = require('../src/services/huntService');
const { ANIMALS } = require('../src/data/huntData');

describe('approach profiles', () => {
    const profiles = Object.values(APPROACH_PROFILES);

    test('every profile has exactly one correct option, one neutral, one wrong', () => {
        for (const p of profiles) {
            const bonuses = p.options.map(o => o.stealthBonus).sort((a, b) => b - a);
            expect(bonuses).toEqual([0.25, 0.05, -0.10]);
            const correct = p.options.find(o => o.id === p.correctId);
            expect(correct).toBeDefined();
            expect(correct.stealthBonus).toBe(0.25);
        }
    });

    test('every hint names the animal it describes', () => {
        const animal = { name: 'Golden Fox', emoji: '🦊', traits: [] };
        for (const p of profiles) {
            expect(p.hint(animal)).toContain('Golden Fox');
        }
    });

    test('trait prey keys its profile on the trait, not the zone', () => {
        expect(pickApproachProfile({ traits: ['spectral'] }).id).toBe('stillness');
        expect(pickApproachProfile({ traits: ['elusive'] }).id).toBe('patience');
        expect(pickApproachProfile({ traits: ['aggressive'] }).id).toBe('cover');
        expect(pickApproachProfile({ traits: ['giant'] }).id).toBe('distance');
        // Multi-trait prey: the most read-defining trait wins.
        expect(pickApproachProfile({ traits: ['giant', 'armored'] }).id).toBe('distance');
        expect(pickApproachProfile({ traits: ['spectral', 'elusive'] }).id).toBe('stillness');
    });

    test('every trait mapping points at a real profile', () => {
        for (const [, profileId] of TRAIT_PROFILE_ORDER) {
            expect(APPROACH_PROFILES[profileId]).toBeDefined();
        }
        for (const id of GENERIC_PROFILE_IDS) {
            expect(APPROACH_PROFILES[id]).toBeDefined();
        }
    });

    test('trait-less prey rolls a behaviour rather than repeating one answer', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) {
            seen.add(pickApproachProfile({ traits: [] }).id);
        }
        expect([...seen].sort()).toEqual([...GENERIC_PROFILE_IDS].sort());
        for (const id of seen) expect(GENERIC_PROFILE_IDS).toContain(id);
    });

    test('the correct answer varies across the animal roster', () => {
        // The old system had one answer per zone. Across the animals of a
        // single zone the profile-driven answer must not collapse back to one.
        const answers = new Set();
        for (const animal of Object.values(ANIMALS)) {
            if (!animal.zones.includes('legendary_peaks') && !animal.zones.includes('all')) continue;
            answers.add(pickApproachProfile(animal).correctId);
        }
        expect(answers.size).toBeGreaterThan(1);
    });
});

describe('pre-rolled encounters', () => {
    function makeHunter() {
        const user = {
            balance: 0,
            streak: { current: 0 },
            markModified() {},
            hunt: null,
        };
        ensureHuntData(user);
        user.hunt.weapons = [{
            tier: 1, name: 'Training Bow', status: 'good',
            currentDurability: 100, maxDurability: 100, baseDurability: 100,
            repairCount: 0, upgrade: null,
        }];
        user.hunt.equippedWeaponIndex = 0;
        user.quests = [];
        return user;
    }

    test('rollHuntEncounter returns an animal that can spawn in the zone', () => {
        const user = makeHunter();
        for (let i = 0; i < 50; i++) {
            const { tier, animal } = rollHuntEncounter(user, 'beginner_forest');
            expect(animal.tier).toBe(tier);
            expect(
                animal.zones.includes('all') || animal.zones.includes('beginner_forest')
            ).toBe(true);
        }
    });

    test('executeHunt hunts the pre-rolled animal instead of rolling its own', () => {
        const user = makeHunter();
        const encounter = rollHuntEncounter(user, 'beginner_forest');
        const result = executeHunt(user, 'beginner_forest', { encounter });
        expect(result.animal).toBe(encounter.animal);
        expect(result.tier).toBe(encounter.tier);
    });

    test('executeHunt still rolls internally when no encounter is passed', () => {
        const user = makeHunter();
        const result = executeHunt(user, 'beginner_forest');
        expect(result.animal).toBeDefined();
        expect(result.tier).toBeDefined();
    });
});
