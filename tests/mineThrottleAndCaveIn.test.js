'use strict';

const {
    ensureMineData,
    applyPayoutModifiers,
    msUntilDailyReset,
    executeMine,
} = require('../src/services/mineService');
const { DEPTHS, LIMITS } = require('../src/data/mineData');

function miner({ dailyCoins = 0, dailyMines = 0, windowAgeMs = 0, level = 20 } = {}) {
    const user = { balance: 0, mining: {}, quests: [], markModified() {} };
    ensureMineData(user);
    Object.assign(user.mining, {
        level, dailyCoins, dailyMines,
        dailyWindowStart: new Date(Date.now() - windowAgeMs),
        pickaxes: [{
            name: 'Steel Pickaxe', tier: 3, slug: 'steel_pickaxe',
            currentDurability: 160, maxDurability: 160, baseDurability: 160,
            repairCount: 0, upgrade: null, status: 'good',
        }],
        equippedPickaxeIndex: 0,
    });
    return user;
}

describe('daily throttles are reported, not just applied', () => {
    const depth = DEPTHS.surface_quarry;

    test('an untouched day throttles nothing', () => {
        const r = applyPayoutModifiers(miner(), 1000, depth);
        expect(r).toMatchObject({ adjustedPayout: 1000, forfeited: 0, softCapped: false, fatigueMult: 1, cappedByHard: false });
    });

    test('fatigue is reported at each threshold', () => {
        const rateAt = dailyMines => applyPayoutModifiers(miner({ dailyMines }), 1000, depth).fatigueMult;
        expect(rateAt(LIMITS.DIM_RETURNS_THRESHOLD_1 - 1)).toBe(1);
        expect(rateAt(LIMITS.DIM_RETURNS_THRESHOLD_1)).toBe(0.85);
        expect(rateAt(LIMITS.DIM_RETURNS_THRESHOLD_2)).toBe(0.70);
        expect(rateAt(LIMITS.DIM_RETURNS_THRESHOLD_3)).toBe(0.55);
    });

    test('the soft cap flags itself and names what it took', () => {
        const r = applyPayoutModifiers(miner({ dailyCoins: LIMITS.DAILY_SOFT_CAP + 5_000 }), 1000, depth);
        expect(r.softCapped).toBe(true);
        expect(r.adjustedPayout).toBe(500);
        expect(r.forfeited).toBe(500);
    });

    test('the hard cap reports the whole haul as forfeited rather than a struck-out zero', () => {
        const r = applyPayoutModifiers(miner({ dailyCoins: LIMITS.DAILY_HARD_CAP }), 1000, depth);
        expect(r.cappedByHard).toBe(true);
        expect(r.adjustedPayout).toBe(0);
        // The number the embed strikes through has to be what was lost, not the zero
        // that was paid.
        expect(r.forfeited).toBe(1000);
    });

    test('forfeited always accounts for the gap between earned and paid', () => {
        for (const dailyCoins of [0, 40_000, LIMITS.DAILY_SOFT_CAP, 149_500, LIMITS.DAILY_HARD_CAP]) {
            const r = applyPayoutModifiers(miner({ dailyCoins }), 1000, depth);
            const earned = Math.round(1000 * r.fatigueMult);
            expect(r.adjustedPayout + r.forfeited).toBe(earned);
        }
    });

    test('the reset countdown tracks the daily window', () => {
        expect(msUntilDailyReset(miner({ windowAgeMs: 6 * 3_600_000 }))).toBeCloseTo(18 * 3_600_000, -4);
        expect(msUntilDailyReset(miner({ windowAgeMs: LIMITS.DAILY_WINDOW_MS + 1000 }))).toBe(0);

        const fresh = { mining: {}, markModified() {} };
        ensureMineData(fresh);
        expect(msUntilDailyReset(fresh)).toBeNull();
    });
});

describe('a cave-in holds the earned multiplier in escrow', () => {
    // Math.random() === 0 makes the dig succeed, the tier roll land on the first
    // eligible tier, and the cave-in roll fire whenever its risk is above zero.
    const always = value => jest.spyOn(Math, 'random').mockReturnValue(value);
    afterEach(() => { if (jest.isMockFunction(Math.random)) Math.random.mockRestore(); });

    const deep = { level: 4, name: 'Deep', emoji: '💎', multiplier: 2.0, caveInRisk: 1.0, durLoss: 3 };
    const safe = { ...deep, caveInRisk: 0.0 };

    test('the multiplier is escrowed rather than destroyed', () => {
        always(0);
        const user = miner();
        const result = executeMine(user, 'surface_quarry', { intensity: deep });

        expect(result.caveIn).toBe(true);
        expect(result.caveInEscrow).toBe(Math.round(result.caveInPayout * (deep.multiplier - 1)));
        expect(result.caveInEscrow).toBeGreaterThan(0);
    });

    test('escaping is worth the same as never caving in', () => {
        always(0);
        const escaped = executeMine(miner(), 'surface_quarry', { intensity: deep });
        const clean   = executeMine(miner(), 'surface_quarry', { intensity: safe });

        // What /mine dig credits on a blast-charge escape: the base haul plus escrow.
        expect(escaped.caveInPayout + escaped.caveInEscrow).toBe(clean.finalPayout);
    });

    test('a level with no multiplier escrows nothing', () => {
        always(0);
        const flat = { ...deep, multiplier: 1.0 };
        const result = executeMine(miner(), 'surface_quarry', { intensity: flat });
        expect(result.caveIn).toBe(true);
        expect(result.caveInEscrow).toBe(0);
    });

    test('the uninterrupted path still pays the multiplier outright', () => {
        always(0);
        const user = miner();
        const result = executeMine(user, 'surface_quarry', { intensity: safe });
        expect(result.caveIn).toBeUndefined();
        expect(result.caveInEscrow).toBeUndefined();
        expect(result.finalPayout).toBeGreaterThan(0);
    });
});
