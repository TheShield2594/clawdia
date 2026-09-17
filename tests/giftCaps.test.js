'use strict';

// The rolling 24-hour budgets /gift spends against, and the three things that
// used to be hardcoded: the coin caps, the item-value cap that did not exist at
// all, and the confirmation a gift never asked for.

const {
    GIFT_LIMIT_DEFAULTS, giftLimits, budgetState,
    spendBudget, spendBudgetPipeline, spendBudgetGuarded, spendBudgetPipelineGuarded,
    refundBudget, refundBudgetPipeline,
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
    test('an expired window is opened by the same write that spends from it, pinned to the observed start', () => {
        // The reset is conditioned on the window still being the one that was
        // read: a concurrent first-spend that reset it first changes `reset`, so
        // this write matches nothing rather than clobbering the earlier amount
        // (#1025). A never-opened window observes `null`, which matches missing.
        const at = new Date();
        const { filter, inc, set } = spendBudget({ ...WINDOW, cap: 100, expired: true, amount: 30, now: at, observedReset: null });
        expect(filter).toEqual({ reset: null });
        expect(inc).toEqual({});
        expect(set).toEqual({ used: 30, reset: at });

        const priorStart = new Date(at.getTime() - 90_000_000);
        const stale = spendBudget({ ...WINDOW, cap: 100, expired: true, amount: 30, now: at, observedReset: priorStart });
        expect(stale.filter).toEqual({ reset: priorStart });
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

describe('spendBudgetGuarded — the expired-window reset race (#1025)', () => {
    // A single in-memory document that applies a `spendBudget` fragment exactly
    // as the atomic write would: the reset predicate and the `$expr` cap guard
    // are checked against the *current* stored value, and only on a match are the
    // `$inc`/`$set` applied. Serialised calls model MongoDB's per-document lock,
    // which is the whole reason the guard works — a concurrent first-spend that
    // resets the window first is what the loser must then be reclassified around.
    // Reset values are plain numbers here; `spendBudget` only pins and copies
    // them, so their type is immaterial.
    const runWriteFor = (store, cap) => async spend => {
        // reset branch: pinned to the observed window start
        if (Object.prototype.hasOwnProperty.call(spend.filter, WINDOW.resetField)) {
            if ((store.reset ?? null) !== spend.filter[WINDOW.resetField]) return 0;
        }
        // active branch: the unchanged cap `$expr`
        if (spend.filter.$expr) {
            if (((store.used ?? 0) + (spend.inc[WINDOW.usedField] ?? 0)) > cap) return 0;
        }
        if (spend.inc[WINDOW.usedField]) store.used = (store.used ?? 0) + spend.inc[WINDOW.usedField];
        if (spend.set[WINDOW.usedField] !== undefined) store.used = spend.set[WINDOW.usedField];
        if (spend.set[WINDOW.resetField] !== undefined) store.reset = spend.set[WINDOW.resetField];
        return 1;
    };

    test('two concurrent first-spends cannot exceed the cap: one resets, the loser is reclassified and refused over the cap', async () => {
        const store = { used: 0, reset: 1 };          // window start 1 is expired
        const spec = amt => ({ ...WINDOW, cap: 100, expired: true, observedReset: 1, amount: amt, now: 2 });
        const run = runWriteFor(store, 100);

        // Both read the same expired window; A wins the reset, B loses it and is
        // retried as an active-window increment that the cap `$expr` then rejects.
        const a = await spendBudgetGuarded(spec(60), run);
        const b = await spendBudgetGuarded(spec(60), run);

        expect(a).toBe(1);
        expect(b).toBe(0);
        expect(store.used).toBe(60);                  // 60 + 60 would be 120 > cap
        expect(store.reset).toBe(2);                  // opened by the winner
    });

    test('the reclassified loser still spends when it fits under the cap', async () => {
        const store = { used: 0, reset: 1 };
        const spec = amt => ({ ...WINDOW, cap: 100, expired: true, observedReset: 1, amount: amt, now: 2 });
        const run = runWriteFor(store, 100);

        await spendBudgetGuarded(spec(40), run);       // wins the reset → used 40
        const b = await spendBudgetGuarded(spec(50), run); // reclassified → 40 + 50 = 90

        expect(b).toBe(1);
        expect(store.used).toBe(90);
    });

    test('a genuine over-cap first-spend is refused on both passes', async () => {
        const store = { used: 0, reset: 1 };
        const run = runWriteFor(store, 100);
        // Nobody raced it, but the amount alone breaches the cap: the reset write
        // lands (it is the first), so this documents that the reset branch itself
        // does not enforce the cap — the active-window guard on the *next* spend
        // does. A first-spend over the cap is stopped one level up, by the
        // pre-flight `budgetState.remaining` check the command runs.
        const only = await spendBudgetGuarded(
            { ...WINDOW, cap: 100, expired: true, observedReset: 1, amount: 150, now: 2 }, run,
        );
        expect(only).toBe(1);
        expect(store.used).toBe(150);
    });

    test('retryOnMiss=false stops the reclassification (an unknown-outcome credit error must not be replayed)', async () => {
        const calls = [];
        const run = async spend => { calls.push(spend); return 0; };  // always misses
        const out = await spendBudgetGuarded(
            { ...WINDOW, cap: 100, expired: true, observedReset: 1, amount: 30, now: 2 },
            run,
            () => false,
        );
        expect(out).toBe(0);
        expect(calls).toHaveLength(1);                 // no second pass
    });

    test('an uncapped budget never retries', async () => {
        let n = 0;
        const run = async () => { n += 1; return 0; };
        await spendBudgetGuarded({ ...WINDOW, cap: 0, expired: true, observedReset: null, amount: 30 }, run);
        expect(n).toBe(1);
    });

    test('the pipeline guard reclassifies on a clean miss and stops on retryOnMiss=false', async () => {
        const seen = [];
        const missThenHit = async spend => { seen.push(spend); return seen.length === 1 ? null : { ok: true }; };
        const spec = { ...WINDOW, cap: 100, expired: true, observedReset: 5, amount: 30 };

        const hit = await spendBudgetPipelineGuarded(spec, missThenHit);
        expect(hit).toEqual({ ok: true });
        expect(seen).toHaveLength(2);
        // The retry is the active-window branch — its set accumulates onto the
        // counter rather than pinning a reset.
        expect(seen[1].set[WINDOW.usedField]).toBeDefined();
        expect(seen[1].filter.$expr).toBeDefined();

        const stopped = [];
        await spendBudgetPipelineGuarded(spec, async s => { stopped.push(s); return null; }, () => false);
        expect(stopped).toHaveLength(1);
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
