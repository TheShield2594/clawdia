'use strict';

// The rolling 24-hour budgets /gift spends against, and the three things that
// used to be hardcoded: the coin caps, the item-value cap that did not exist at
// all, and the confirmation a gift never asked for.

const {
    GIFT_LIMIT_DEFAULTS, giftLimits, budgetState,
    spendBudget, spendBudgetPipeline, refundBudget, refundBudgetPipeline,
} = require('../src/utils/giftCaps');
const { applyPipelineUpdate, evaluate } = require('./helpers/pipelineUpdate');

const WINDOW = { usedField: 'used', resetField: 'reset' };

describe('giftLimits', () => {
    test('falls back to the defaults when a guild has stored nothing', () => {
        expect(giftLimits(undefined)).toEqual(GIFT_LIMIT_DEFAULTS);
        expect(giftLimits({ economy: {} })).toEqual(GIFT_LIMIT_DEFAULTS);
    });

    test('a stored zero means unlimited and survives the fallback', () => {
        // `||` would read 0 as "not set" and quietly reinstate the cap the admin
        // just turned off, which is the whole reason this is not a one-liner.
        const limits = giftLimits({ economy: { giftCoinCapDaily: 0, giftItemValueCapDaily: 0 } });
        expect(limits.coinSend).toBe(0);
        expect(limits.itemValueSend).toBe(0);
        expect(limits.coinReceive).toBe(GIFT_LIMIT_DEFAULTS.coinReceive);
    });

    test('a corrupt value falls back to the default rather than to zero', () => {
        // Zero is "no limit", so parsing junk as zero would silently remove the
        // anti-funnel cap instead of leaving it in place.
        const limits = giftLimits({ economy: { giftCoinCapDaily: 'lots', giftCoinReceiveCapDaily: -5 } });
        expect(limits.coinSend).toBe(GIFT_LIMIT_DEFAULTS.coinSend);
        expect(limits.coinReceive).toBe(GIFT_LIMIT_DEFAULTS.coinReceive);
    });
});

describe('budgetState', () => {
    const now = Date.UTC(2026, 0, 2, 12);

    test('a window that has never been opened counts as expired', () => {
        expect(budgetState(null, { ...WINDOW, cap: 100, now })).toMatchObject({ expired: true, used: 0, remaining: 100 });
        expect(budgetState({ used: 40 }, { ...WINDOW, cap: 100, now })).toMatchObject({ expired: true, used: 0 });
    });

    test('an open window reports what is left of it', () => {
        const doc = { used: 40, reset: new Date(now - 3_600_000) };
        expect(budgetState(doc, { ...WINDOW, cap: 100, now })).toMatchObject({ expired: false, used: 40, remaining: 60 });
    });

    test('a window older than 24h has expired and starts from zero', () => {
        const doc = { used: 100, reset: new Date(now - 86_400_001) };
        expect(budgetState(doc, { ...WINDOW, cap: 100, now })).toMatchObject({ expired: true, used: 0, remaining: 100 });
    });

    test('an overspent window floors at zero rather than going negative', () => {
        const doc = { used: 250, reset: new Date(now) };
        expect(budgetState(doc, { ...WINDOW, cap: 100, now }).remaining).toBe(0);
    });

    test('cap 0 is unlimited, and remaining compares as such', () => {
        const state = budgetState({ used: 9_999, reset: new Date(now) }, { ...WINDOW, cap: 0, now });
        expect(state.unlimited).toBe(true);
        expect(state.remaining).toBe(Infinity);
        expect(1e9 > state.remaining).toBe(false);
    });
});

describe('spendBudget', () => {
    test('an expired window is opened by the same write that spends from it', () => {
        const at = new Date();
        const { filter, inc, set } = spendBudget({ ...WINDOW, cap: 100, expired: true, amount: 30, now: at });
        expect(filter).toEqual({});
        expect(inc).toEqual({});
        expect(set).toEqual({ used: 30, reset: at });
    });

    test('an open window carries the cap as a filter, not just a prior check', () => {
        // The pre-flight check is the friendly message; this expression is what
        // stops two concurrent gifts from each passing a check the other made
        // stale.
        const { filter, inc } = spendBudget({ ...WINDOW, cap: 100, expired: false, amount: 30 });
        expect(inc).toEqual({ used: 30 });
        expect(evaluate(filter.$expr, { used: 70 })).toBe(true);   // exactly at the cap
        expect(evaluate(filter.$expr, { used: 71 })).toBe(false);  // one over
        expect(evaluate(filter.$expr, {})).toBe(true);             // never spent
    });

    test('an unlimited budget writes and filters nothing', () => {
        expect(spendBudget({ ...WINDOW, cap: 0, expired: false, amount: 30 })).toEqual({ filter: {}, inc: {}, set: {} });
    });
});

describe('refundBudget', () => {
    test('a refund undoes a spend on either branch', () => {
        const doc = { used: 0, reset: null };
        const spend = spendBudget({ ...WINDOW, cap: 100, expired: true, amount: 30 });
        Object.assign(doc, spend.set);
        expect(doc.used).toBe(30);

        const refund = refundBudget({ ...WINDOW, cap: 100, amount: 30 });
        doc.used += refund.used;
        expect(doc.used).toBe(0);
    });

    test('nothing is refunded against a budget that never charged', () => {
        expect(refundBudget({ ...WINDOW, cap: 0, amount: 30 })).toEqual({});
    });
});

describe('the pipeline dialect', () => {
    // The recipient's side of an item gift is credited by a pipeline update, so
    // its budget has to be an aggregation expression rather than a $inc. Same
    // arithmetic, and these check it really is the same.
    test('spending accumulates onto the existing counter', () => {
        const doc = { used: 40, reset: new Date() };
        const { set } = spendBudgetPipeline({ ...WINDOW, cap: 100, expired: false, amount: 25 });
        applyPipelineUpdate(doc, [{ $set: set }]);
        expect(doc.used).toBe(65);
    });

    test('spending on an expired window opens it at the amount', () => {
        const doc = { used: 999, reset: new Date(0) };
        const at = new Date();
        const { set } = spendBudgetPipeline({ ...WINDOW, cap: 100, expired: true, amount: 25, now: at });
        applyPipelineUpdate(doc, [{ $set: set }]);
        expect(doc.used).toBe(25);
        expect(doc.reset).toBe(at);
    });

    test('the guard rejects a credit that would breach the cap', () => {
        const { filter } = spendBudgetPipeline({ ...WINDOW, cap: 100, expired: false, amount: 25 });
        expect(evaluate(filter.$expr, { used: 75 })).toBe(true);
        expect(evaluate(filter.$expr, { used: 76 })).toBe(false);
    });

    test('a refund never drives the counter below zero', () => {
        // The refund runs after a write that may or may not have landed, so a
        // bare subtraction could hand back more allowance than the day started
        // with.
        const doc = { used: 10 };
        applyPipelineUpdate(doc, [{ $set: refundBudgetPipeline({ ...WINDOW, cap: 100, amount: 25 }) }]);
        expect(doc.used).toBe(0);
    });
});
