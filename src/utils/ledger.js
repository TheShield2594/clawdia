'use strict';

/**
 * Reads one member's ledger back out (#1009).
 *
 * Every coin path writes a `Transaction`, and until this module three things
 * read them — the shop's price mover, the market's volume stats and the
 * newspaper's signals — and none of them a person. A player whose coins moved
 * had no receipt and a moderator investigating one had to open Mongo. This is
 * the read side: `/bank statement` serves a member their own rows, and the
 * dashboard's member ledger serves a moderator anyone's, plus the owed payouts
 * sitting beside them.
 *
 * Strictly read-only. Nothing here writes a `Transaction` or moves a coin — the
 * point of the issue is that a ledger you cannot read is no ledger, not that the
 * ledger needed more writers.
 */

const Transaction = require('../models/Transaction');
const FailedJob = require('../models/FailedJob');
const { isOwedPayout } = require('./owedPayout');

const DEFAULT_PAGE_SIZE = 10;

/**
 * One page of a member's transactions, newest first.
 *
 * The `{ guildId, userId, createdAt: -1 }` index on the model serves both the
 * match and the sort, so a member with a long history is not a scan of the
 * guild's. `page` is clamped to at least 1 and, once the total is known, to the
 * last page that has rows, so a caller asking for page 99 of a two-page ledger
 * lands on page 2 rather than an empty embed.
 *
 * @param {object}  opts
 * @param {string}  opts.userId
 * @param {string}  opts.guildId
 * @param {number}  [opts.page=1]      1-based
 * @param {number}  [opts.pageSize=10]
 * @param {object}  [opts.Model]       injectable for tests
 * @returns {Promise<{items: object[], total: number, page: number, pages: number, pageSize: number}>}
 */
async function fetchTransactions({ userId, guildId, page = 1, pageSize = DEFAULT_PAGE_SIZE, Model = Transaction } = {}) {
    const size = Math.max(1, Math.floor(pageSize) || DEFAULT_PAGE_SIZE);
    const total = await Model.countDocuments({ guildId, userId });
    const pages = Math.max(1, Math.ceil(total / size));
    const wanted = Math.max(1, Math.floor(page) || 1);
    const current = Math.min(wanted, pages);

    const items = total === 0 ? [] : await Model.find({ guildId, userId })
        .sort({ createdAt: -1 })
        .skip((current - 1) * size)
        .limit(size)
        .lean();

    return { items, total, page: current, pages, pageSize: size };
}

/**
 * A member's unsettled owed payouts — the `FailedJob` records `recordOwedPayout`
 * wrote that name this user and have not been resolved.
 *
 * This is what makes the dashboard ledger honest about "my coins vanished": a
 * debit whose credit half failed is neither in the `Transaction` list (it never
 * landed) nor lost — it is sitting here, keyed, waiting for
 * `npm run payouts:replay`. A resolved record is history and left out; a
 * pending, retrying or exhausted one is an outstanding debt and shown.
 *
 * `payload.userId` is not indexed, so this is scoped to the guild first (which
 * is) and the user filtered within it. That is a dashboard admin lookup, not a
 * hot path, and the owed queue is small by design.
 *
 * @returns {Promise<object[]>} newest first
 */
async function fetchOwedPayouts({ userId, guildId, OwedModel = FailedJob } = {}) {
    const records = await OwedModel.find({
        guildId,
        status: { $ne: 'resolved' },
        'payload.userId': userId,
    }).sort({ createdAt: -1 }).lean();

    return records.filter(isOwedPayout).map(r => ({
        id:           String(r._id),
        status:       r.status,
        service:      r.service,
        jobName:      r.jobName,
        kind:         r.payload?.kind ?? null,
        amount:       typeof r.payload?.amount === 'number' ? r.payload.amount : null,
        itemId:       r.payload?.itemId ?? null,
        quantity:     typeof r.payload?.quantity === 'number' ? r.payload.quantity : null,
        payoutKey:    r.payload?.payoutKey ?? null,
        attempts:     r.attempts ?? null,
        errorMessage: r.errorMessage ?? null,
        createdAt:    r.createdAt ?? null,
    }));
}

/**
 * A machine `type` rendered as words: `gift_send` → `Gift Send`.
 *
 * The stored `type` is what every writer files (`daily`, `duel_win`,
 * `shop_buy`, …); there are far too many to enumerate a friendly name for each,
 * and the `note` beside it already carries the human detail. So this only tidies
 * the slug, and the caller shows the note as the detail line.
 */
function prettyType(type) {
    return String(type ?? 'unknown')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
}

/** `+1,234` / `-1,234` / `0`, with a thousands separator. A non-number is `0`. */
function signedAmount(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) return '0';
    const sign = n > 0 ? '+' : '-';
    return `${sign}${Math.abs(n).toLocaleString()}`;
}

module.exports = {
    DEFAULT_PAGE_SIZE,
    fetchTransactions,
    fetchOwedPayouts,
    prettyType,
    signedAmount,
};
