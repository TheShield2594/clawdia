'use strict';

const {
    isCondemned,
    quoteRepair,
    applyRepair,
    updateWeaponStatus,
    applyDurabilityLoss,
    calculateSuccessChance,
    applyPayoutModifiers,
} = require('../src/services/huntService');
const { ZONES, LIMITS, WEAPON_BY_TIER } = require('../src/data/huntData');
const { getPityBonus } = require('../src/utils/pityBonus');

function makeWeapon(overrides = {}) {
    return {
        name: 'Wooden Rifle',
        tier: 1,
        currentDurability: 80,
        maxDurability: 80,
        baseDurability: 80,
        repairCount: 0,
        upgrade: null,
        status: 'good',
        ...overrides,
    };
}

/** Repairs until the weapon is condemned, returning it. */
function repairUntilCondemned(weapon) {
    for (let i = 0; i < 50 && !isCondemned(weapon); i++) {
        weapon.currentDurability = 0;
        updateWeaponStatus(weapon);
        const res = applyRepair(weapon, weapon.maxDurability);
        if (res.error) break;
    }
    return weapon;
}

describe('weapon condemnation', () => {
    test('shop repairs eventually condemn a weapon', () => {
        const weapon = repairUntilCondemned(makeWeapon());
        expect(isCondemned(weapon)).toBe(true);
        expect(weapon.maxDurability / weapon.baseDurability).toBeLessThan(0.20);
    });

    test('a condemned weapon cannot be repaired even after it breaks', () => {
        const weapon = repairUntilCondemned(makeWeapon());

        // Break it: updateWeaponStatus labels it 'broken', which used to mask
        // 'condemned' and reopen the repair path for another cycle.
        weapon.currentDurability = 0;
        updateWeaponStatus(weapon);
        expect(weapon.status).toBe('broken');

        expect(isCondemned(weapon)).toBe(true);
        expect(quoteRepair(weapon, 20).error).toMatch(/condemned/i);
        expect(applyRepair(weapon, 20).error).toMatch(/condemned/i);
    });

    test('breaking a condemned weapon does not restore any durability', () => {
        const weapon = repairUntilCondemned(makeWeapon());
        weapon.currentDurability = 0;
        updateWeaponStatus(weapon);
        const repairsBefore = weapon.repairCount;

        applyRepair(weapon, weapon.maxDurability);

        expect(weapon.currentDurability).toBe(0);
        expect(weapon.repairCount).toBe(repairsBefore);
    });

    test('a healthy weapon is not condemned', () => {
        const weapon = makeWeapon({ currentDurability: 10 });
        expect(isCondemned(weapon)).toBe(false);
        expect(quoteRepair(weapon, 20).error).toBeUndefined();
    });
});

describe('quoteRepair', () => {
    test('prices a repair without mutating the weapon', () => {
        const weapon = makeWeapon({ currentDurability: 20 });
        const snapshot = { ...weapon };

        const quote = quoteRepair(weapon, 60);

        expect(quote.cost).toBe(3 * WEAPON_BY_TIER[1].repairCostPer20);
        expect(quote.amount).toBe(60);
        expect(weapon).toEqual(snapshot);
    });

    test('agrees with the cost applyRepair actually charges', () => {
        const weapon = makeWeapon({ currentDurability: 20 });
        const quote  = quoteRepair(weapon, 60);
        const result = applyRepair(weapon, 60);

        expect(result.cost).toBe(quote.cost);
        expect(result.restoredAmount).toBe(quote.amount);
    });

    test('refuses a weapon already at full durability', () => {
        expect(quoteRepair(makeWeapon(), 20).error).toMatch(/full durability/i);
    });
});

describe('pity curve', () => {
    const limits = { PITY_CONSECUTIVE_FAILS: 4, PITY_BONUS_PER_STACK: 0.15 };

    test('grants nothing before the streak reaches the threshold', () => {
        for (let fails = 0; fails < limits.PITY_CONSECUTIVE_FAILS; fails++) {
            expect(getPityBonus(fails, limits)).toBe(0);
        }
    });

    test('starts on the Nth straight failure and stacks one per further failure', () => {
        expect(getPityBonus(4, limits)).toBeCloseTo(0.15);
        expect(getPityBonus(5, limits)).toBeCloseTo(0.30);
        expect(getPityBonus(6, limits)).toBeCloseTo(0.45);
    });

    test('caps at PITY_CONSECUTIVE_FAILS stacks', () => {
        expect(getPityBonus(7, limits)).toBeCloseTo(0.60);
        expect(getPityBonus(50, limits)).toBeCloseTo(0.60);
    });

    test('treats a missing streak as no bonus', () => {
        expect(getPityBonus(undefined, limits)).toBe(0);
    });

    test('feeds through calculateSuccessChance', () => {
        const base = { hunt: { level: 1, prestige: 0, activeCharm: null, activeFocus: false, consecutiveFails: 0 } };
        const pitied = { hunt: { ...base.hunt, consecutiveFails: 4 } };
        const weapon = makeWeapon();

        const without = calculateSuccessChance(base, weapon, ZONES.beginner_forest);
        const with4   = calculateSuccessChance(pitied, weapon, ZONES.beginner_forest);

        expect(with4 - without).toBeCloseTo(0.15);
    });
});

describe('gathering-yield charges', () => {
    function makeUser(dailyCoins) {
        return {
            hunt: { dailyCoins, dailyHunts: 0, prestige: 0 },
            activeEffects: [
                { type: 'silvered_talisman', charges: 5, expiresAt: new Date(Date.now() + 3600_000) },
            ],
            markModified: () => {},
        };
    }

    test('doubles the payout and spends a charge with headroom to spare', () => {
        const user = makeUser(0);

        const { adjustedPayout } = applyPayoutModifiers(user, 5000, ZONES.beginner_forest);

        expect(adjustedPayout).toBe(10_000);
        expect(user.activeEffects[0].charges).toBe(4);
    });

    test('still pays past the soft cap, where x2 beats the halving', () => {
        const user = makeUser(LIMITS.DAILY_SOFT_CAP);

        const { adjustedPayout } = applyPayoutModifiers(user, 5000, ZONES.beginner_forest);

        expect(adjustedPayout).toBe(5000);
        expect(user.activeEffects[0].charges).toBe(4);
    });

    test('is not consumed when the hard-cap headroom makes doubling worthless', () => {
        const user = makeUser(LIMITS.DAILY_HARD_CAP - 1);

        const { adjustedPayout } = applyPayoutModifiers(user, 5000, ZONES.beginner_forest);

        expect(adjustedPayout).toBe(1);
        expect(user.activeEffects[0].charges).toBe(5);
    });
});

describe('applyDurabilityLoss', () => {
    test('reinforced stock reduces loss but never below 1', () => {
        const weapon = makeWeapon({ upgrade: 'reinforced_stock' });
        applyDurabilityLoss(weapon, 1);
        expect(weapon.currentDurability).toBe(79);
    });

    test('never drives durability below zero', () => {
        const weapon = makeWeapon({ currentDurability: 2 });
        applyDurabilityLoss(weapon, 10);
        expect(weapon.currentDurability).toBe(0);
        expect(weapon.status).toBe('broken');
    });
});
