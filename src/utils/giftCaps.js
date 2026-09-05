'use strict';

/**
 * The daily budgets `/gift` spends against.
 *
 * There are four of them — coins out, coins in, item value out, item value in —
 * and each is a rolling 24-hour window stored as a counter plus the timestamp it
 * started. gift.js used to spell every one of those windows out inline: read the
 * reset date, subtract, branch on whether the window had expired, and build a
 * different filter and a different update for each branch. Two windows was
 * already forty lines of near-identical ternaries; four would have been eighty,
 * and the branch that resets an expired window is exactly where an off-by-one
 * silently doubles somebody's allowance.
 *
 * So the window lives here, once, in two halves:
 *
 *   `budgetState`  — what is left right now, for the message shown to the user
 *                    before anything is written.
 *   `spendBudget`  — the filter and update fragments that take it, for folding
 *                    into the same atomic write as the balance change, so the
 *                    check and the spend cannot be separated by a concurrent
 *                    gift.
 *
 * The pre-flight check is the friendly refusal and the filter is what enforces
 * the cap; both have to exist, and only the second one is load-bearing.
 */

const DAY_MS = 86_400_000;

/**
 * The four rolling budgets, by the fields that hold them. Paired here so a call
 * site names a budget rather than restating a pair of field names each time.
 *
 * They live in this module rather than in gift.js because the coin pair is no
 * longer gift.js's alone: `/bank transfer` spends against the same two windows
 * through utils/coinTransfer.js (#897), and two tables of field names is exactly
 * the arrangement in which one of them ends up naming `dailyGiftReset` for the
 * receive window.
 */
const BUDGETS = Object.freeze({
    coinSend:         { usedField: 'dailyGiftSent',              resetField: 'dailyGiftReset' },
    coinReceive:      { usedField: 'dailyGiftReceived',          resetField: 'dailyGiftReceivedReset' },
    itemValueSend:    { usedField: 'dailyGiftItemValueSent',     resetField: 'dailyGiftItemValueReset' },
    itemValueReceive: { usedField: 'dailyGiftItemValueReceived', resetField: 'dailyGiftItemValueReceivedReset' },
});

/**
 * Defaults for every configurable gift limit, used when a guild has no value
 * stored. These are the constants that used to live at the top of gift.js.
 */
const GIFT_LIMIT_DEFAULTS = Object.freeze({
    coinSend:         10_000,
    coinReceive:      25_000,
    itemValueSend:    250_000,
    itemValueReceive: 500_000,
    confirmThreshold: 5_000,
});

/** Guild settings key backing each limit. */
const LIMIT_KEYS = Object.freeze({
    coinSend:         'giftCoinCapDaily',
    coinReceive:      'giftCoinReceiveCapDaily',
    itemValueSend:    'giftItemValueCapDaily',
    itemValueReceive: 'giftItemValueReceiveCapDaily',
    confirmThreshold: 'giftConfirmThreshold',
});

/**
 * Resolve all five limits for one guild.
 *
 * A stored `0` means "no limit" and has to survive `??` — which it does, and
 * `||` would not, which is the whole reason this is not a one-liner at each
 * call site. Anything absent or unparseable falls back to the default rather
 * than to zero: a corrupt settings document should not quietly remove the
 * anti-funnel caps.
 */
function giftLimits(guildSettings) {
    const economy = guildSettings?.economy ?? {};
    const read = name => {
        const raw = economy[LIMIT_KEYS[name]];
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : GIFT_LIMIT_DEFAULTS[name];
    };
    return {
        coinSend:         read('coinSend'),
        coinReceive:      read('coinReceive'),
        itemValueSend:    read('itemValueSend'),
        itemValueReceive: read('itemValueReceive'),
        confirmThreshold: read('confirmThreshold'),
    };
}

/**
 * Where one rolling budget stands on `doc` right now.
 *
 * @param {object} doc         the user document (may be null — a user with no
 *                             document has spent nothing)
 * @param {object} spec
 * @param {string} spec.usedField   counter path, e.g. `dailyGiftSent`
 * @param {string} spec.resetField  window-start path, e.g. `dailyGiftReset`
 * @param {number} spec.cap         0 for unlimited
 * @param {number} [spec.now]
 * @returns {{ expired, used, cap, unlimited, remaining }} `remaining` is
 *          `Infinity` when the cap is off, so callers can compare against it
 *          without special-casing.
 */
function budgetState(doc, { usedField, resetField, cap, now = Date.now() }) {
    const startedAt = doc?.[resetField] ? new Date(doc[resetField]).getTime() : null;
    // A window with no start has never been opened, so it counts as expired and
    // the first spend opens it.
    const expired = startedAt === null || Number.isNaN(startedAt) || (now - startedAt) >= DAY_MS;
    const used = expired ? 0 : Math.max(0, doc?.[usedField] ?? 0);
    const unlimited = !cap;
    return {
        expired,
        used,
        cap,
        unlimited,
        remaining: unlimited ? Infinity : Math.max(0, cap - used),
    };
}

/**
 * The write fragments that spend `amount` from a budget.
 *
 * @returns {{ filter, inc, set }} to be merged into the caller's own query and
 *          update. `filter` is empty when the window is being opened fresh or
 *          the cap is off; otherwise it is the `$expr` that makes the update
 *          match nothing once the cap would be exceeded — which is what stops
 *          two concurrent gifts from each passing a check the other invalidated.
 */
function spendBudget({ usedField, resetField, cap, expired, amount, now = new Date() }) {
    // Cap off: nothing to enforce and nothing worth counting. The stale counter
    // left behind is harmless — its window start is old, so re-enabling the cap
    // finds an expired window and starts from zero.
    if (!cap) return { filter: {}, inc: {}, set: {} };

    if (expired) {
        return { filter: {}, inc: {}, set: { [usedField]: amount, [resetField]: now } };
    }

    return {
        filter: {
            $expr: { $lte: [{ $add: [{ $ifNull: [`$${usedField}`, 0] }, amount] }, cap] },
        },
        inc: { [usedField]: amount },
        set: {},
    };
}

/**
 * `spendBudget` for a caller whose update is an aggregation pipeline.
 *
 * The recipient's side of an item gift is credited by
 * `utils/inventoryGrant.grantInventoryItem`, which is a pipeline update — so its
 * budget has to be written as an aggregation expression rather than a `$inc`,
 * and returned as `{ filter, set }` for that helper's `guard` and `extraSet`.
 * Same windows, same arithmetic, different dialect.
 *
 * @returns {{ filter, set }} `set` holds aggregation expressions, not operators.
 */
function spendBudgetPipeline({ usedField, resetField, cap, expired, amount, now = new Date() }) {
    if (!cap) return { filter: {}, set: {} };

    if (expired) {
        return { filter: {}, set: { [usedField]: amount, [resetField]: now } };
    }

    return {
        filter: {
            $expr: { $lte: [{ $add: [{ $ifNull: [`$${usedField}`, 0] }, amount] }, cap] },
        },
        set: {
            [usedField]: { $add: [{ $ifNull: [`$${usedField}`, 0] }, amount] },
        },
    };
}

/**
 * `refundBudget` in pipeline dialect, for the same reason.
 *
 * Clamped at zero rather than trusting the counter: the refund path runs after a
 * write that may or may not have landed, and a negative counter would hand the
 * sender back more allowance than they started the day with.
 */
function refundBudgetPipeline({ usedField, cap, amount }) {
    if (!cap) return {};
    return {
        [usedField]: {
            $max: [0, { $subtract: [{ $ifNull: [`$${usedField}`, 0] }, amount] }],
        },
    };
}

/**
 * `refundBudgetPipeline`, gated on the budget window it was spent in (#873).
 *
 * A rollback that lands runs microseconds after the debit, so the window is the
 * one the debit wrote and the gate is a no-op. It exists for the other case: a
 * rollback that could not land is filed as an owed payout, and
 * `npm run payouts:replay` may settle it days later. These counters reset every
 * 24 hours, so decrementing one then would take the refund out of a window the
 * gift was never charged against — handing the sender allowance they did not
 * spend, on a day they did not spend it.
 *
 * `window` is the `resetField` value read off the document the debit returned.
 * Comparing it inside the write is what makes this free: no second read, and no
 * chance of the window turning over between a check and the update. A `window`
 * that no longer matches leaves the counter exactly as it is.
 *
 * A `window` that arrives in the wrong shape — a payload that went through a
 * serialiser somewhere and came back a string rather than a Date — compares
 * unequal and skips the refund. That is the conservative direction: an
 * allowance that stays spent costs a day's cap, and one refunded twice is a cap
 * that does not hold.
 */
function windowedRefundExpr({ usedField, resetField, cap, amount, window = null }) {
    if (!cap) return {};
    const refunded = { $max: [0, { $subtract: [{ $ifNull: [`$${usedField}`, 0] }, amount] }] };
    if (!window) return { [usedField]: refunded };
    return {
        [usedField]: {
            $cond: [
                { $eq: [`$${resetField}`, window] },
                refunded,
                { $ifNull: [`$${usedField}`, 0] },
            ],
        },
    };
}

/**
 * Undo a `spendBudget` on the rollback path.
 *
 * Always a `$inc` of the negative, whichever branch was taken: a window the
 * spend opened was `$set` to exactly `amount`, so decrementing it lands on zero
 * and leaves the (now correct) window start alone.
 */
function refundBudget({ usedField, cap, amount }) {
    if (!cap) return {};
    return { [usedField]: -amount };
}

module.exports = {
    DAY_MS,
    BUDGETS,
    GIFT_LIMIT_DEFAULTS,
    LIMIT_KEYS,
    giftLimits,
    budgetState,
    spendBudget,
    spendBudgetPipeline,
    refundBudget,
    refundBudgetPipeline,
    windowedRefundExpr,
};
