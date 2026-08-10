'use strict';

const { executeHunt } = require('../src/services/huntService');

function makeHuntUser() {
    return {
        balance: 0,
        activeEffects: [],
        streak: { current: 0 },
        accountPrestige: { rank: 0 },
        quests: [],
        pets: [],
        hunt: {
            stamina: 10, level: 1, prestige: 0, xp: 0,
            weapons: [{
                name: 'Wooden Rifle', tier: 1, slug: 'wooden_rifle',
                currentDurability: 800, maxDurability: 800, baseDurability: 800,
                repairCount: 0, upgrade: null, status: 'good',
            }],
            equippedWeaponIndex: 0,
            activeZone: 'beginner_forest',
            unlockedZones: ['beginner_forest'],
            ammo: {}, consumables: {}, materials: {}, trophies: [],
            activeBait: null, activeBaitHuntsLeft: 0,
            activeCharm: null, activeCharmHuntsLeft: 0,
            activeFocus: false, activeXpScroll: false,
            luckyPaw: false, precisionScope: false,
            totalHunts: 0, successfulHunts: 0, totalEarned: 0,
            legendaryKills: 0, eventKills: 0, bestPayout: 0,
            consecutiveFails: 0, sinceRare: 0,
            dailyCoins: 0, dailyHunts: 0, dailyWindowStart: new Date(),
            injuryUntil: null, lastHunt: null,
        },
        markModified: () => {},
    };
}

/**
 * executeHunt is driven by RNG, so these assert the rule across many runs rather
 * than stubbing Math.random and coupling to the order of the roll calls.
 */
describe('stamina cost of a failed hunt', () => {
    const runs = [];

    beforeAll(() => {
        for (let i = 0; i < 600; i++) {
            const user = makeHuntUser();
            const before = user.hunt.stamina;
            const result = executeHunt(user, 'beginner_forest');
            runs.push({
                spent:    before - user.hunt.stamina,
                success:  result.success,
                severity: result.failure?.severity?.id ?? null,
                spared:   result.staminaSpared,
            });
        }
    });

    test('the sample actually covers both clean misses and harsher failures', () => {
        expect(runs.some(r => r.severity === 'clean_miss')).toBe(true);
        expect(runs.some(r => !r.success && r.severity !== 'clean_miss')).toBe(true);
        expect(runs.some(r => r.success)).toBe(true);
    });

    test('a clean miss costs no stamina', () => {
        const cleanMisses = runs.filter(r => r.severity === 'clean_miss');
        for (const run of cleanMisses) {
            expect(run.spared).toBe(true);
            expect(run.spent).toBe(0);
        }
    });

    test('every harsher failure still costs a point', () => {
        const harsh = runs.filter(r => !r.success && r.severity !== 'clean_miss');
        for (const run of harsh) {
            expect(run.spared).toBe(false);
            expect(run.spent).toBe(1);
        }
    });

    test('a successful hunt still costs a point', () => {
        // Venomous prey docks an extra point on top, so a kill costs at least one.
        const wins = runs.filter(r => r.success);
        for (const run of wins) {
            expect(run.spared).toBe(false);
            expect(run.spent).toBeGreaterThanOrEqual(1);
        }
    });

    test('a clean miss still wears the weapon and bumps the failure streak', () => {
        let user, result;
        do {
            user = makeHuntUser();
            result = executeHunt(user, 'beginner_forest');
        } while (result.failure?.severity?.id !== 'clean_miss');

        expect(user.hunt.weapons[0].currentDurability).toBeLessThan(800);
        expect(user.hunt.consecutiveFails).toBe(1);
        expect(user.hunt.totalHunts).toBe(1);
    });
});
