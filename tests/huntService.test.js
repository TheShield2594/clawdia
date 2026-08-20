'use strict';

const {
    applyPayoutModifiers,
    applyDailyReset,
    activateConsumable,
    resolveApexEncounter,
    calculateSuccessChance,
    applyAimBonus,
} = require('../src/services/huntService');
const { ZONES, LIMITS } = require('../src/data/huntData');

function makeUser(huntOverrides = {}) {
    return {
        hunt: {
            level: 1,
            prestige: 0,
            dailyCoins: 0,
            dailyHunts: 0,
            consecutiveFails: 0,
            activeBait: null,
            activeCharm: null,
            activeFocus: false,
            staminaTonicsToday: 0,
            lastTonicDayReset: null,
            dailyWindowStart: null,
            consumables: { stamina_tonic: 5 },
            weapons: [{ tier: 1, currentDurability: 80, maxDurability: 80, baseDurability: 80, upgrade: null }],
            equippedWeaponIndex: 0,
            stamina: 5,
            ...huntOverrides,
        },
        markModified: () => {},
    };
}

const zone = ZONES.beginner_forest;

describe('applyPayoutModifiers', () => {
    test('never pushes dailyCoins past the hard cap', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP - 1 });
        const { adjustedPayout } = applyPayoutModifiers(user, 50_000, zone);
        expect(adjustedPayout).toBeLessThanOrEqual(1);
    });

    test('returns zero once dailyCoins is at or above the hard cap', () => {
        const user = makeUser({ dailyCoins: LIMITS.DAILY_HARD_CAP });
        const { adjustedPayout, cappedByHard } = applyPayoutModifiers(user, 1000, zone);
        expect(adjustedPayout).toBe(0);
        expect(cappedByHard).toBe(true);
    });
});

describe('calculateSuccessChance', () => {
    test('is clamped within [0.10, 0.95] even under extreme inputs', () => {
        const user = makeUser({ level: 1, consecutiveFails: 0 });
        const brokenWeapon = { tier: 1, currentDurability: 0, maxDurability: 80, baseDurability: 80, upgrade: null };
        const chance = calculateSuccessChance(user, brokenWeapon, zone);
        expect(chance).toBeGreaterThanOrEqual(0.10);
        expect(chance).toBeLessThanOrEqual(0.95);
    });
});

describe('daily reset / stamina tonic window sync', () => {
    test('activateConsumable does not grant extra tonic uses once the daily window rolls over', () => {
        const now = Date.now();
        const user = makeUser({
            dailyWindowStart: new Date(now - LIMITS.DAILY_WINDOW_MS - 1000),
            lastTonicDayReset: new Date(now - LIMITS.DAILY_WINDOW_MS - 1000),
            staminaTonicsToday: LIMITS.STAMINA_TONICS_PER_DAY,
            stamina: 0,
        });

        // Daily window has expired; applyDailyReset resets both clocks together.
        applyDailyReset(user);
        expect(user.hunt.staminaTonicsToday).toBe(0);

        const result = activateConsumable(user, 'stamina_tonic');
        expect(result.success).toBe(true);
        expect(user.hunt.staminaTonicsToday).toBe(1);
    });

    test('activateConsumable does not silently reset the tonic count mid-window', () => {
        const user = makeUser({
            dailyWindowStart: new Date(),
            lastTonicDayReset: new Date(),
            staminaTonicsToday: LIMITS.STAMINA_TONICS_PER_DAY,
            stamina: 0,
        });

        const result = activateConsumable(user, 'stamina_tonic');
        expect(result.success).toBe(false);
        expect(user.hunt.staminaTonicsToday).toBe(LIMITS.STAMINA_TONICS_PER_DAY);
    });
});

describe('resolveApexEncounter', () => {
    test('applies durability loss to the pinned weaponIndex, not whatever is currently equipped', () => {
        const user = makeUser({
            weapons: [
                { tier: 1, currentDurability: 80, maxDurability: 80, baseDurability: 80, upgrade: null },
                { tier: 2, currentDurability: 80, maxDurability: 80, baseDurability: 80, upgrade: null },
            ],
            equippedWeaponIndex: 1, // player re-equipped after the encounter started
        });
        const animal = { payoutMin: 100, payoutMax: 200, emoji: '🦌', name: 'Deer' };
        const apexType = { name: 'Apex', emoji: '⚔️', phases: [{ correct: 'match' }, { correct: 'hold' }] };

        resolveApexEncounter(user, animal, 'rare', ['match', 'hold'], apexType, 0);

        expect(user.hunt.weapons[0].currentDurability).toBeLessThan(80);
        expect(user.hunt.weapons[1].currentDurability).toBe(80);
    });
});

describe('applyAimBonus', () => {
    test('leaves crit chance alone when the aim phase did not run', () => {
        expect(applyAimBonus(0.08)).toBe(0.08);
        expect(applyAimBonus(0.08, 0)).toBe(0.08);
    });

    test('adds a shot taken inside the window', () => {
        expect(applyAimBonus(0.05, 0.18)).toBeCloseTo(0.23);
    });

    test('takes the penalty off a rushed shot', () => {
        // The old guard was `aimBonus > 0`, which threw the penalty away — so a
        // player who fired early paid nothing for it.
        expect(applyAimBonus(0.20, -0.05)).toBeCloseTo(0.15);
    });

    test('never pushes crit chance below zero', () => {
        expect(applyAimBonus(0.03, -0.05)).toBe(0);
    });

    test('still respects the hard cap', () => {
        expect(applyAimBonus(0.20, 0.18)).toBe(LIMITS.MAX_CRIT_CHANCE);
    });
});
