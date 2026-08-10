'use strict';

const {
    isCondemned,
    quoteRepair,
    applyRepair,
    updatePickaxeStatus,
    applyPayoutModifiers,
    activateConsumable,
    ensureMineData,
} = require('../src/services/mineService');
const { DEPTHS, LIMITS, PICKAXE_BY_TIER } = require('../src/data/mineData');

function makePickaxe(overrides = {}) {
    return {
        name: 'Wooden Pickaxe',
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

/** Repairs until the pickaxe is condemned, returning it. */
function repairUntilCondemned(pickaxe) {
    for (let i = 0; i < 50 && !isCondemned(pickaxe); i++) {
        pickaxe.currentDurability = 0;
        updatePickaxeStatus(pickaxe);
        const res = applyRepair(pickaxe, pickaxe.maxDurability);
        if (res.error) break;
    }
    return pickaxe;
}

describe('pickaxe condemnation', () => {
    test('shop repairs eventually condemn a pickaxe', () => {
        const pickaxe = repairUntilCondemned(makePickaxe());
        expect(isCondemned(pickaxe)).toBe(true);
        expect(pickaxe.maxDurability / pickaxe.baseDurability).toBeLessThan(0.20);
    });

    test('a condemned pickaxe cannot be repaired even after it breaks', () => {
        const pickaxe = repairUntilCondemned(makePickaxe());

        // Break it: updatePickaxeStatus labels it 'broken', which used to mask
        // 'condemned' and reopen the repair path for another cycle — a loop that
        // let one pickaxe be nursed forever instead of replaced.
        pickaxe.currentDurability = 0;
        updatePickaxeStatus(pickaxe);
        expect(pickaxe.status).toBe('broken');

        expect(isCondemned(pickaxe)).toBe(true);
        expect(quoteRepair(pickaxe, 20).error).toMatch(/condemned/i);
        expect(applyRepair(pickaxe, 20).error).toMatch(/condemned/i);
    });

    test('breaking a condemned pickaxe does not restore any durability', () => {
        const pickaxe = repairUntilCondemned(makePickaxe());
        pickaxe.currentDurability = 0;
        updatePickaxeStatus(pickaxe);
        const repairsBefore = pickaxe.repairCount;

        applyRepair(pickaxe, pickaxe.maxDurability);

        expect(pickaxe.currentDurability).toBe(0);
        expect(pickaxe.repairCount).toBe(repairsBefore);
    });

    test('a healthy pickaxe is not condemned', () => {
        const pickaxe = makePickaxe({ currentDurability: 10 });
        expect(isCondemned(pickaxe)).toBe(false);
        expect(quoteRepair(pickaxe, 20).error).toBeUndefined();
    });
});

describe('quoteRepair', () => {
    test('prices a repair without mutating the pickaxe', () => {
        const pickaxe = makePickaxe({ currentDurability: 20 });
        const snapshot = { ...pickaxe };

        const quote = quoteRepair(pickaxe, 60);

        expect(quote.cost).toBe(3 * PICKAXE_BY_TIER[1].repairCostPer20);
        expect(quote.amount).toBe(60);
        expect(pickaxe).toEqual(snapshot);
    });

    test('agrees with the cost applyRepair actually charges', () => {
        const pickaxe = makePickaxe({ currentDurability: 20 });
        const quote   = quoteRepair(pickaxe, 60);
        const result  = applyRepair(pickaxe, 60);

        expect(result.cost).toBe(quote.cost);
        expect(result.restoredAmount).toBe(quote.amount);
    });

    test('refuses a pickaxe already at full durability', () => {
        expect(quoteRepair(makePickaxe(), 20).error).toMatch(/full durability/i);
    });
});

describe('gathering-yield charges', () => {
    function makeUser(dailyCoins) {
        return {
            mining: { dailyCoins, dailyMines: 0, prestige: 0 },
            activeEffects: [
                { type: 'silvered_talisman', charges: 5, expiresAt: new Date(Date.now() + 3600_000) },
            ],
            markModified: () => {},
        };
    }

    test('doubles the payout and spends a charge with headroom to spare', () => {
        const user = makeUser(0);

        const { adjustedPayout } = applyPayoutModifiers(user, 5000, DEPTHS.surface_quarry);

        expect(adjustedPayout).toBe(10_000);
        expect(user.activeEffects[0].charges).toBe(4);
    });

    test('still pays past the soft cap, where x2 beats the halving', () => {
        const user = makeUser(LIMITS.DAILY_SOFT_CAP);

        const { adjustedPayout } = applyPayoutModifiers(user, 5000, DEPTHS.surface_quarry);

        expect(adjustedPayout).toBe(5000);
        expect(user.activeEffects[0].charges).toBe(4);
    });

    test('is not consumed when the hard-cap headroom makes doubling worthless', () => {
        const user = makeUser(LIMITS.DAILY_HARD_CAP - 1);

        const { adjustedPayout } = applyPayoutModifiers(user, 5000, DEPTHS.surface_quarry);

        expect(adjustedPayout).toBe(1);
        expect(user.activeEffects[0].charges).toBe(5);
    });

    test('reports the effect and remaining charges so the embed can show them', () => {
        const user = makeUser(0);

        const { gatheringYield } = applyPayoutModifiers(user, 5000, DEPTHS.surface_quarry);

        expect(gatheringYield).toMatchObject({ effect: 'silvered_talisman', chargesLeft: 4 });
        expect(gatheringYield.label).toBe('Silvered Talisman');
    });
});

describe('mine lock', () => {
    function makeMiner(lockStock) {
        const user = { markModified: () => {} };
        ensureMineData(user);
        user.mining.consumables.mine_lock = lockStock;
        return user;
    }

    test('arming a lock spends one from the bag', () => {
        const user = makeMiner(2);

        const result = activateConsumable(user, 'mine_lock');

        expect(result.success).toBe(true);
        expect(user.mining.mineLockActive).toBe(true);
        expect(user.mining.consumables.mine_lock).toBe(1);
    });

    test('refuses to stack a second lock on an already armed mine', () => {
        const user = makeMiner(2);
        activateConsumable(user, 'mine_lock');

        const second = activateConsumable(user, 'mine_lock');

        expect(second.success).toBe(false);
        expect(second.error).toMatch(/already has an active/i);
        expect(user.mining.consumables.mine_lock).toBe(1);
    });

    test('refuses to arm a lock nobody owns', () => {
        const user = makeMiner(0);

        const result = activateConsumable(user, 'mine_lock');

        expect(result.success).toBe(false);
        expect(user.mining.mineLockActive).toBe(false);
    });
});
