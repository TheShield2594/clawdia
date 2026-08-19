'use strict';

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { applyPayoutModifiers, getDiminishingReturns } = require('../src/services/huntService');
const { ZONES, LIMITS } = require('../src/data/huntData');
const { __test__ } = require('../src/commands/economy/hunt');
const { buildDailyTollField, buildTodayField } = __test__;

const FRESH_WINDOW = () => new Date(Date.now() - 3600_000);

function hunter({ hunts = 0, coins = 0 } = {}) {
    return {
        balance: 0,
        hunt: { dailyHunts: hunts, dailyCoins: coins, prestige: 0, dailyWindowStart: FRESH_WINDOW() },
    };
}

function payout(opts, raw = 1000) {
    return applyPayoutModifiers(hunter(opts), raw, ZONES.beginner_forest);
}

describe('diminishing returns bands', () => {
    it('is a clean multiplier below the first threshold', () => {
        const dim = getDiminishingReturns(LIMITS.DIM_RETURNS_THRESHOLD_1 - 1);
        expect(dim.multiplier).toBe(1);
        expect(dim.nextAt).toBe(LIMITS.DIM_RETURNS_THRESHOLD_1);
    });

    it('steps down at each threshold', () => {
        expect(getDiminishingReturns(LIMITS.DIM_RETURNS_THRESHOLD_1).multiplier).toBeCloseTo(0.85);
        expect(getDiminishingReturns(LIMITS.DIM_RETURNS_THRESHOLD_2).multiplier).toBeCloseTo(0.70);
        expect(getDiminishingReturns(LIMITS.DIM_RETURNS_THRESHOLD_3).multiplier).toBeCloseTo(0.55);
    });

    it('has nowhere further to fall in the last band', () => {
        const dim = getDiminishingReturns(LIMITS.DIM_RETURNS_THRESHOLD_3 + 50);
        expect(dim.nextAt).toBeNull();
        expect(dim.nextMultiplier).toBeNull();
    });

    it('points at the next band from inside the current one', () => {
        const dim = getDiminishingReturns(LIMITS.DIM_RETURNS_THRESHOLD_1 + 1);
        expect(dim.threshold).toBe(LIMITS.DIM_RETURNS_THRESHOLD_1);
        expect(dim.nextAt).toBe(LIMITS.DIM_RETURNS_THRESHOLD_2);
        expect(dim.nextMultiplier).toBeCloseTo(0.70);
    });
});

describe('payout reporting', () => {
    it('reports nothing withheld on a fresh day', () => {
        const { adjustedPayout, dailyReport } = payout({});
        expect(adjustedPayout).toBe(1000);
        expect(dailyReport.lostToDaily).toBe(0);
        expect(dailyReport.dimReturns).toBeNull();
        expect(dailyReport.softCapped).toBe(false);
    });

    it('names the diminishing-returns cut', () => {
        const { adjustedPayout, dailyReport } = payout({ hunts: LIMITS.DIM_RETURNS_THRESHOLD_1 + 5 });
        expect(adjustedPayout).toBe(850);
        expect(dailyReport.grossPayout).toBe(1000);
        expect(dailyReport.lostToDaily).toBe(150);
        expect(dailyReport.dimReturns.multiplier).toBeCloseTo(0.85);
    });

    it('names the soft cap', () => {
        const { adjustedPayout, dailyReport } = payout({ coins: LIMITS.DAILY_SOFT_CAP + 1000 });
        expect(adjustedPayout).toBe(500);
        expect(dailyReport.softCapped).toBe(true);
        expect(dailyReport.lostToDaily).toBe(500);
    });

    it('accounts for both penalties stacking', () => {
        const { adjustedPayout, dailyReport } = payout({
            hunts: LIMITS.DIM_RETURNS_THRESHOLD_3 + 1,
            coins: LIMITS.DAILY_SOFT_CAP + 1000,
        });
        // 1000 → x0.55 diminishing → 550 → halved by the soft cap → 275.
        expect(adjustedPayout).toBe(275);
        expect(dailyReport.dimReturns.multiplier).toBeCloseTo(0.55);
        expect(dailyReport.softCapped).toBe(true);
        expect(dailyReport.lostToDaily).toBe(725);
    });

    it('flags the headroom clamp only when it bites beyond the soft cap', () => {
        const roomy = payout({ coins: LIMITS.DAILY_HARD_CAP - 5000 });
        expect(roomy.dailyReport.headroomClamped).toBe(false);

        const tight = payout({ coins: LIMITS.DAILY_HARD_CAP - 100 });
        expect(tight.adjustedPayout).toBe(100);
        expect(tight.dailyReport.headroomClamped).toBe(true);
    });

    it('reports the gross for a doubled payout in doubled terms', () => {
        const user = hunter({ hunts: LIMITS.DIM_RETURNS_THRESHOLD_1 });
        const result = applyPayoutModifiers(user, 1000, ZONES.beginner_forest, { reuseGatheringYield: true });
        expect(result.adjustedPayout).toBe(1700);
        expect(result.dailyReport.grossPayout).toBe(2000);
        expect(result.dailyReport.lostToDaily).toBe(300);
    });
});

describe('the Daily Limits embed field', () => {
    function field(opts, raw = 1000) {
        const user = hunter(opts);
        const result = { dailyReport: payout(opts, raw).dailyReport };
        return buildDailyTollField(result, user, '💰');
    }

    it('stays off when nothing was withheld', () => {
        expect(field({})).toBeNull();
    });

    it('stays off when the hunt never reached the payout stage', () => {
        expect(buildDailyTollField({}, hunter(), '💰')).toBeNull();
    });

    it('explains a diminishing-returns cut and where the next one lands', () => {
        const f = field({ hunts: LIMITS.DIM_RETURNS_THRESHOLD_1 + 1 });
        expect(f.value).toContain('Diminishing returns');
        expect(f.value).toContain('−15%');
        expect(f.value).toContain(String(LIMITS.DIM_RETURNS_THRESHOLD_2));
    });

    it('explains the soft cap and says what the kill was worth', () => {
        const f = field({ coins: LIMITS.DAILY_SOFT_CAP + 1 });
        expect(f.value).toContain('soft cap');
        expect(f.value).toContain('💰1,000');   // gross
        expect(f.value).toContain('💰500');     // withheld
        expect(f.value).toMatch(/Resets in/);
    });

    it('fits Discord limits with every penalty active', () => {
        const f = field({ hunts: 200, coins: LIMITS.DAILY_HARD_CAP - 50 }, 50_000);
        expect(f.value.length).toBeLessThanOrEqual(1024);
        expect(f.name.length).toBeLessThanOrEqual(256);
    });
});

describe('the Today profile field', () => {
    it('shows the wall before a hunter reaches it', () => {
        const f = buildTodayField({ dailyHunts: 10, dailyCoins: 5000, dailyWindowStart: FRESH_WINDOW() }, '💰');
        expect(f.value).toContain('×1.00');
        expect(f.value).toContain(`Drops to ×0.85 at ${LIMITS.DIM_RETURNS_THRESHOLD_1} hunts`);
        expect(f.value).toContain('Soft cap');
    });

    it('says plainly when the soft cap is already biting', () => {
        const f = buildTodayField({ dailyHunts: 95, dailyCoins: 92_000, dailyWindowStart: FRESH_WINDOW() }, '💰');
        expect(f.value).toContain('×0.70');
        expect(f.value).toContain('payouts halved');
    });

    it('handles a hunter who has not hunted today', () => {
        const f = buildTodayField({}, '💰');
        expect(f.value).toContain('×1.00');
        expect(f.value.length).toBeLessThanOrEqual(1024);
    });

    it('fits Discord limits at the hard cap', () => {
        const f = buildTodayField({ dailyHunts: 500, dailyCoins: LIMITS.DAILY_HARD_CAP, dailyWindowStart: FRESH_WINDOW() }, '💰');
        expect(f.value.length).toBeLessThanOrEqual(1024);
        expect(f.value).toContain('█'.repeat(12));
    });
});
