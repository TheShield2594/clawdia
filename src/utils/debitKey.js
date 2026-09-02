'use strict';

/**
 * A debit whose outcome can be found out afterwards (#969).
 *
 * #807 made *credits* exactly-once by putting a key in the write's own filter
 * (src/utils/payoutKey.js). Debits had no equivalent, and the gap is not really
 * about duplicates — it is that a failed debit cannot be reconciled at all. When
 * `findOneAndUpdate` rejects on a debit, the caller cannot tell which of two
 * things happened:
 *
 *   - the write never landed, so the coins are still with the player and
 *     refunding would **mint** them;
 *   - the write committed and lost its response, so the coins are gone and not
 *     refunding **destroys** them.
 *
 * Both branches are currency bugs, so there is nothing safe for the caller to
 * do. `takeEscrow` in src/utils/duelEscrow.js named the case in a comment rather
 * than guessing. Every guarded debit in the economy has the same ambiguity —
 * `chargeExact`, the shop charges, `placeWager` — it is simply most visible
 * where coins sit outside a balance and something has to reconcile them.
 *
 * The key closes it because it makes the outcome *observable*. A debit that
 * writes its own key into the document leaves a mark that survives the lost
 * response, so "did this debit land?" stops being a question about a network
 * round trip and becomes a question about a document — one that can be answered
 * by reading it, seconds or minutes later, from anywhere.
 *
 * Three things are built on that, and the third is the one that actually ends
 * the ambiguity:
 *
 *   1. `debitCoinsOnce` — the keyed debit. A second attempt with the same key
 *      moves no coins, so a retry after an unknown failure is safe.
 *   2. `debitCoinsOrKnow` — retry, and when every attempt has failed, read the
 *      key. The caller ends knowing whether the coins left.
 *   3. `reverseKeyedDebit` — the compensation, conditioned on the same key. It
 *      credits back **only if** that debit is recorded as having landed, and
 *      marks it reversed in the same write. Against a debit that never landed it
 *      is a no-op, so a caller that does not know can compensate anyway: it
 *      cannot mint, and it cannot pay twice.
 *
 * ── Why a separate array ────────────────────────────────────────────────────
 *
 * `paidPayouts` documents a 30-day retention window and a 200-entry cap on the
 * assumption that only replayable payouts carry keys — a user earns a handful a
 * month. Debits are a far higher-frequency writer, and sharing the array would
 * let them push credit keys out of it: the cap would start deciding retention
 * instead of the window, which weakens the exactly-once guarantee for *credits*.
 * So this has its own array and its own bounds.
 *
 * Its bounds can also be much smaller, because the two are reconciled on
 * completely different timescales. A credit key has to outlive an operator
 * noticing an owed payout and running `npm run payouts:replay`, which is why it
 * is measured in weeks. A debit key has to outlive the request that wrote it —
 * the resolution read below happens in the same call, and the compensation right
 * after it. Hours is already several orders of magnitude of slack.
 */

const { delay } = require('./delay');
const { NOT_FROZEN } = require('./economyFreeze');
const { counterSetExpr } = require('./balanceDebit');

/**
 * How long a debit key is honoured.
 *
 * Past it, a key is evicted and a retry of that debit would charge a second
 * time — the same correctness bound `payoutKey.js` documents, at a different
 * scale. The window that has to be covered is one request and its retries,
 * which is seconds; a day is the slack.
 */
const RETENTION_HOURS = 24;
const RETENTION_MS    = RETENTION_HOURS * 60 * 60 * 1000;

/**
 * Hard cap on the array, as a document-size backstop.
 *
 * Smaller than `paidPayouts`' 200 because this document is read on nearly every
 * command and because the entries are worth far less: a key more than a few
 * seconds old has already done its job. If a caller ever keys something frequent
 * enough that fifty accumulate inside the retention window, the cap and not the
 * window decides — and the guarantee weakens to "the last fifty debits", which
 * is still far more than any single request needs.
 */
const KEY_CAP = 50;

/** Filter clause that makes an already-applied debit match nothing. */
function debitKeyGuard(key) {
    return { 'spentDebits.key': { $ne: key } };
}

/**
 * Pipeline `$set` expression for `spentDebits` after recording `key`: drops
 * anything past the retention window, then appends.
 *
 * `$$NOW` is the server's clock, so the stamp does not depend on the caller's.
 * An entry with no `at` is kept rather than pruned — keeping a key too long is a
 * debit not taken twice, dropping one early is a debit taken twice.
 *
 * `$concatArrays` and not `$setUnion`, for the reason payoutKey.js gives: a set
 * has no defined order, so the eviction would drop arbitrary keys instead of the
 * oldest and the bound would mean nothing. The filter already guarantees the key
 * is absent, so a plain append is correct.
 */
function debitKeyAppendExpr(key) {
    return {
        $slice: [
            {
                $concatArrays: [
                    {
                        $filter: {
                            input: { $ifNull: ['$spentDebits', []] },
                            as: 'd',
                            cond: {
                                $gt: [
                                    { $ifNull: ['$$d.at', '$$NOW'] },
                                    { $subtract: ['$$NOW', RETENTION_MS] },
                                ],
                            },
                        },
                    },
                    [{ key, at: '$$NOW' }],
                ],
            },
            -KEY_CAP,
        ],
    };
}

/**
 * Whether this debit is recorded on the document, read rather than inferred.
 *
 * This is the whole point of the key, so it is worth being exact about what the
 * answer means. `landed: true` says the debit's write committed — the coins have
 * left, whatever the caller saw. `landed: false` says it did not, because
 * nothing else in the system writes this key: it is built by one caller for one
 * operation, so its absence is not a race, it is an answer.
 *
 * `reversed` distinguishes a debit that landed and has since been given back
 * from one that landed and still stands.
 *
 * @returns {Promise<{landed: boolean, reversed: boolean, doc: ?object}>}
 */
async function resolveKeyedDebit(Model, filter, key) {
    const doc = await Model.findOne(filter, { balance: 1, economyFrozen: 1, spentDebits: 1 }).lean();
    if (!doc) return { landed: false, reversed: false, doc: null };

    const entry = (doc.spentDebits ?? []).find(e => e?.key === key);
    return { landed: !!entry, reversed: entry?.reversed === true, doc };
}

/**
 * Why a keyed debit matched nothing.
 *
 * Four reasons, and callers want to treat them differently: two are the player's
 * (they cannot pay, or they are frozen), one means there is nobody to charge,
 * and one means the update should have matched and something wrote concurrently.
 * `duplicate` is not a failure at all — it is the key doing its job.
 *
 * Returns one of `'duplicate' | 'reversed' | 'frozen' | 'insufficient' |
 * 'missing' | 'unknown'`.
 */
async function classifyUnmatchedDebit(Model, filter, key, amount) {
    const { landed, reversed, doc } = await resolveKeyedDebit(Model, filter, key);
    if (!doc) return 'missing';
    if (landed) return reversed ? 'reversed' : 'duplicate';
    // Order matters: a frozen member with too little money is refused for being
    // frozen, because that is the one an admin can explain.
    if (doc.economyFrozen === true) return 'frozen';
    if ((doc.balance ?? 0) < amount) return 'insufficient';
    return 'unknown';
}

/**
 * Takes `amount` coins exactly once, keyed by `key`.
 *
 * The mirror of `creditCoinsOnce`: the key in the write's own filter, so a
 * second attempt is a no-op rather than a second charge. The balance guard and
 * the freeze guard ride in the same filter for the same reason they do
 * everywhere else — there is no gap between the check and the spend.
 *
 * `counters` are `{ path: delta }` moved in the same update, so bookkeeping that
 * belongs with the stake (a `lifetimeGambled`, say) cannot land without it.
 *
 * @returns {Promise<{status: string, doc: ?object}>} status `'debited'` when the
 *   coins moved on this call, otherwise the classification above.
 */
async function debitCoinsOnce(filter, amount, key, options = {}) {
    const { counters = {}, extraSet = {}, Model = require('../models/User') } = options;
    const wanted = Math.max(0, Math.floor(amount) || 0);
    if (!wanted) return { status: 'debited', doc: null };

    const debited = await Model.findOneAndUpdate(
        { ...filter, ...NOT_FROZEN, ...debitKeyGuard(key), balance: { $gte: wanted } },
        [{
            $set: {
                balance:      { $subtract: [{ $ifNull: ['$balance', 0] }, wanted] },
                spentDebits:  debitKeyAppendExpr(key),
                ...counterSetExpr(counters),
                ...extraSet,
            },
        }],
        { updatePipeline: true, new: true },
    );

    if (debited) return { status: 'debited', doc: debited };
    return { status: await classifyUnmatchedDebit(Model, filter, key, wanted), doc: null };
}

const DEFAULT_ATTEMPTS = 3;

/**
 * `debitCoinsOnce`, retried, and — when every attempt has failed — resolved by
 * reading the key.
 *
 * This is the function #969 is about. The retry is only safe because of the key;
 * the resolution is only possible because of the key; and what the caller gets
 * back is a state it can act on rather than an exception it cannot.
 *
 * @returns {Promise<{resolved: boolean, debited: boolean, status: string, doc: ?object, error: ?Error}>}
 *
 * `resolved: false` is the one answer that still means "do not compensate on
 * your own judgement" — the database could not be reached even to ask. It is not
 * the old ambiguity, though: the key is on the document if the debit landed, so
 * the same question can be asked again later, and `reverseKeyedDebit` can be
 * called blind in the meantime without minting anything.
 */
async function debitCoinsOrKnow(filter, amount, key, options = {}) {
    const { attempts = DEFAULT_ATTEMPTS, Model = require('../models/User') } = options;
    const opts = { ...options, Model };

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const { status, doc } = await debitCoinsOnce(filter, amount, key, opts);
            // 'duplicate' is a success and the reason the retry is allowed to
            // exist: an earlier attempt landed and only its response was lost.
            return {
                resolved: true,
                debited: status === 'debited' || status === 'duplicate',
                status, doc, error: null,
            };
        } catch (err) {
            lastError = err;
        }
        if (attempt < attempts) await delay(attempt * 200);
    }

    // Every attempt threw, so nothing came back to read. Ask the document
    // instead: the key is there if any of those attempts committed.
    try {
        const { landed, reversed } = await resolveKeyedDebit(Model, filter, key);
        return {
            resolved: true,
            debited: landed && !reversed,
            status: landed ? (reversed ? 'reversed' : 'duplicate') : 'failed',
            doc: null,
            error: lastError,
        };
    } catch (err) {
        return { resolved: false, debited: false, status: 'unknown', doc: null, error: err };
    }
}

/**
 * Gives back a keyed debit — but only one that actually happened.
 *
 * The compensation the ambiguity used to make impossible. Both halves are one
 * write: the filter matches only a document carrying this key un-reversed, and
 * the update credits the coins and marks the entry reversed. So
 *
 *   - a debit that never landed leaves no key, the filter matches nothing, and
 *     no coins are created;
 *   - a debit already reversed matches nothing either, so a second call cannot
 *     pay twice;
 *   - and a caller that does not know which of those it is can simply call it.
 *
 * No freeze guard, deliberately: this returns coins the player already had, and
 * a sanction that ate a refund would destroy them. Refunds land regardless,
 * exactly as they do everywhere else in the economy.
 *
 * `counters` are `{ path: delta }` — pass the negation of whatever the debit
 * advanced, so a stake that comes back takes its bookkeeping with it.
 *
 * @returns {Promise<{reversed: boolean, resolved: boolean, doc: ?object, error: ?Error}>}
 *
 * `reversed: false` with `resolved: true` is the good no-op: there was nothing
 * to give back. `resolved: false` means the write itself could not be made, and
 * the key is still on the document for a later attempt.
 */
async function reverseKeyedDebit(filter, amount, key, options = {}) {
    const {
        counters = {}, attempts = DEFAULT_ATTEMPTS, Model = require('../models/User'),
    } = options;
    const wanted = Math.max(0, Math.floor(amount) || 0);

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const back = await Model.findOneAndUpdate(
                { ...filter, spentDebits: { $elemMatch: { key, reversed: { $ne: true } } } },
                {
                    $inc: { balance: wanted, ...counters },
                    // Positional-filtered rather than a pipeline `$map`: the
                    // credit and the mark are plain operators, and mixing them
                    // with an aggregation expression would need the whole update
                    // rewritten as a pipeline for no gain.
                    $set: { 'spentDebits.$[entry].reversed': true },
                },
                { new: true, arrayFilters: [{ 'entry.key': key }] },
            );
            return { reversed: !!back, resolved: true, doc: back, error: null };
        } catch (err) {
            lastError = err;
        }
        if (attempt < attempts) await delay(attempt * 200);
    }

    return { reversed: false, resolved: false, doc: null, error: lastError };
}

module.exports = {
    RETENTION_HOURS, RETENTION_MS, KEY_CAP,
    debitKeyGuard, debitKeyAppendExpr,
    resolveKeyedDebit, classifyUnmatchedDebit,
    debitCoinsOnce, debitCoinsOrKnow, reverseKeyedDebit,
};
