'use strict';

/**
 * Exactly-once payouts (#807).
 *
 * Every path that credits a user and writes the credit down as owed on failure
 * is at-least-once, not exactly-once. A write can commit server-side and lose
 * its response — a dropped connection, a client timeout on a write that landed.
 * The caller sees a failure, records the payout as owed (src/utils/owedPayout.js),
 * and `npm run payouts:replay -- --pay` later applies it a second time. The
 * five-minute claim lease from #806 stops two replay *runs* racing each other;
 * this is the other half, duplicates across time from a write whose outcome was
 * never known.
 *
 * There is no transaction to reach for — the deployment is a standalone mongod
 * and PR #520 removed the transactions the codebase used — and a separate key
 * collection does not work either: the insert and the credit would be two
 * writes, so a crash between them loses the payout, which is the #804 failure
 * this is built on top of. The guard has to be in the *same* write as the
 * credit, which means it has to be in that write's filter.
 *
 * So the key lives on the user document and the credit writes it itself:
 *
 *     filter: { userId, guildId, 'paidPayouts.key': { $ne: key } }
 *     update: [{ $set: { balance: <credit>, paidPayouts: <append key> } }]
 *
 * A key already present makes the filter match nothing, so no coins move. An
 * aggregation-pipeline update because operator syntax cannot be mixed with the
 * aggregation expressions the append needs; the precedent is already in the
 * tree at src/commands/economy/daily.js:404-420 (a drop and the milestone flag
 * recording it, in one update) and in `extraSet` on src/utils/balanceDebit.js
 * and src/utils/inventoryGrant.js.
 *
 * `$concatArrays` rather than the idiomatic `$setUnion`, despite `$addToSet`
 * being what this looks like. `$setUnion` returns a *set*, with no defined
 * order, so the eviction below would drop arbitrary keys instead of the oldest
 * and the retention bound would mean nothing. The filter already guarantees the
 * key is absent, so a plain append is both correct and order-preserving.
 */

const DEFAULT_USER = require('../models/User');

/**
 * How long a key is honoured.
 *
 * This is a correctness parameter, not a tidiness one: once a key is evicted, a
 * replay of that payout double-pays again, exactly as it did before this
 * existed. So the window has to comfortably exceed the longest plausible gap
 * between a credit whose response was lost and an operator running
 * `npm run payouts:replay -- --pay`.
 *
 * Thirty days. The owed records that drive a replay surface on /health and in
 * the dashboard's dead-letter view as soon as the sweep fails, so the realistic
 * gap is hours; a month is two orders of magnitude of slack on that, and an
 * operator who finds a month-old owed record has bigger problems than a
 * double-paid 500 coins. Ageing rather than counting is deliberate — the bound
 * that matters is measured in operator response time, not in how many payouts
 * the user happened to receive meanwhile.
 */
const RETENTION_DAYS = 30;
const RETENTION_MS   = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Hard cap on the array, as a document-size backstop rather than a correctness
 * bound. Only payouts that can be replayed carry a key — the two scheduled
 * jobs, and the `commitBalanceDelta` callers that opt in — so a user earns a
 * handful a month and never approaches this. It exists so that a future caller
 * keying something high-frequency cannot grow an unbounded array on a document
 * that is read on nearly every command; if that ever happens, the eviction and
 * not the retention window decides, and the guarantee above weakens to "the
 * last 200 payouts".
 */
const KEY_CAP = 200;

/** Filter clause that makes an already-applied payout match nothing. */
function payoutKeyGuard(key) {
    return { 'paidPayouts.key': { $ne: key } };
}

/**
 * Pipeline `$set` expression for `paidPayouts` after recording `key`: drops
 * anything past the retention window, then appends.
 *
 * `$$NOW` is the server's clock at the moment of the update, so the stamp does
 * not depend on the caller's. An entry with no `at` at all is *kept* rather than
 * pruned — keeping a key too long is a payout not made twice, dropping one early
 * is a payout made twice, and only one of those is worth defaulting to.
 */
function payoutKeyAppendExpr(key) {
    return {
        $slice: [
            {
                $concatArrays: [
                    {
                        $filter: {
                            input: { $ifNull: ['$paidPayouts', []] },
                            as: 'p',
                            cond: {
                                $gt: [
                                    { $ifNull: ['$$p.at', '$$NOW'] },
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
 * Why a guarded credit matched nothing.
 *
 * This is the whole reason the guard needs care. Before it, a `null` from
 * `findOneAndUpdate` meant one thing — no user document in that guild — and
 * #804 was about that being treated as success. With the key in the filter,
 * `null` also means "already paid", and the two want opposite handling: one is
 * owed and must be recorded, the other is done and must be dropped. Telling
 * them apart needs a second read, so here it is in one place rather than
 * open-coded at three call sites where one of them would get it wrong.
 *
 * Returns:
 *   'duplicate' — the key is on the document; the payout has already landed
 *   'missing'   — there is no document to credit; the payout is still owed
 *   'unknown'   — the document is there without the key, so the update should
 *                 have matched. Something wrote concurrently. Treated as owed
 *                 by callers, which is safe now: a replay carries the same key
 *                 and will guard itself.
 */
async function classifyUnmatchedPayout(Model, filter, key) {
    const doc = await Model.findOne(filter, { paidPayouts: 1 }).lean();
    if (!doc) return 'missing';
    return (doc.paidPayouts ?? []).some(entry => entry?.key === key) ? 'duplicate' : 'unknown';
}

/** True for the unique-index violation an upsert raises when the document exists. */
function isDuplicateKeyError(err) {
    return err?.code === 11000 || err?.code === 11001;
}

/**
 * Credits `amount` coins exactly once, keyed by `key`.
 *
 * No `upsert`: a payout is owed to a user who has played, and creating a
 * document for one who has none would resurrect pruned accounts. That keeps
 * `'missing'` meaning what it meant before the guard existed.
 *
 * @returns {Promise<{status: 'paid'|'duplicate'|'missing'|'unknown', doc: ?object}>}
 */
async function creditCoinsOnce(filter, amount, key, options = {}) {
    const { extraSet = {}, projection, Model = DEFAULT_USER } = options;

    const credited = await Model.findOneAndUpdate(
        { ...filter, ...payoutKeyGuard(key) },
        [{
            $set: {
                balance:     { $add: [{ $ifNull: ['$balance', 0] }, amount] },
                paidPayouts: payoutKeyAppendExpr(key),
                ...extraSet,
            },
        }],
        projection
            ? { updatePipeline: true, new: true, projection }
            : { updatePipeline: true, new: true },
    );

    if (credited) return { status: 'paid', doc: credited };
    return { status: await classifyUnmatchedPayout(Model, filter, key), doc: null };
}

/**
 * Grants `quantity` of `itemId` exactly once, keyed by `key`.
 *
 * The item side is cheaper than the coin side because `grantInventoryItem`
 * already takes an `extraSet` written in the same update; all it needed was the
 * guard on its filter.
 *
 * `upsert` is two steps rather than one. A guarded upsert on a document that
 * already carries the key matches nothing and so tries to *insert*, which the
 * unique `{ userId, guildId }` index rejects — a correct outcome reached by an
 * error, and an error that is indistinguishable from a genuine race unless the
 * classification is done first. So: guarded update, classify, and only actually
 * upsert when there is no document at all. The guard stays on the insert too,
 * so a document created in between still cannot be credited twice.
 *
 * A duplicate-key error from that insert is *not* read as "already paid". It
 * means only that a document now exists — which is true both when this payout
 * has already landed and when another writer simply created the user in
 * between, and in the second case nothing has been granted. Two sweeps
 * returning two expired listings to a seller with no document is exactly that
 * race, and calling it a duplicate would drop the second return without even
 * recording it as owed. So the guarded update is retried against the document
 * that now exists, and only then is the answer classified.
 *
 * @returns {Promise<{status: 'paid'|'duplicate'|'missing'|'unknown', doc: ?object}>}
 */
async function grantItemOnce(filter, itemId, quantity, key, options = {}) {
    const { extraSet = {}, upsert = false, Model = DEFAULT_USER } = options;
    const { grantInventoryItem } = require('./inventoryGrant');
    const { userId, guildId } = filter;

    const grantOptions = {
        extraSet: { paidPayouts: payoutKeyAppendExpr(key), ...extraSet },
        guard: payoutKeyGuard(key),
        Model,
    };
    const grant = extra => grantInventoryItem(userId, guildId, itemId, quantity, { ...grantOptions, ...extra });

    const granted = await grant();
    if (granted) return { status: 'paid', doc: granted };

    const status = await classifyUnmatchedPayout(Model, filter, key);
    if (status !== 'missing' || !upsert) return { status, doc: null };

    try {
        return { status: 'paid', doc: await grant({ upsert: true }) };
    } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;

        // Somebody created the document between the classification and the
        // insert. Whether this payout was part of what they wrote is what the
        // retry answers.
        const retried = await grant();
        if (retried) return { status: 'paid', doc: retried };
        return { status: await classifyUnmatchedPayout(Model, filter, key), doc: null };
    }
}

/**
 * The key constructors, here rather than at the call sites, because the job that
 * pays and the replay that re-pays have to agree on the string exactly — a
 * mismatch is a guard that never fires and a double payment nobody notices.
 *
 * `week` is the ISO week bucket from src/utils/weeklyChampion.js, which is
 * already the unit the champion record is keyed by; `category` because a week
 * has one champion per competition. `listingId` is the market listing's `_id`,
 * which the job has already deleted by the time a credit can fail, so it is
 * unique for good.
 */
function weeklyChampionPayoutKey(week, category) {
    return `weekly:${week}:${category}`;
}

/**
 * The hourly competition this replaced is gone, and nothing builds one of these
 * any more. It stays because owed payouts outlive the job that owed them: a
 * credit that failed on the last hourly sweep before the switch is still in the
 * queue, and `npm run payouts:replay` has to rebuild the same key it was
 * originally guarded with or the replay pays a second time.
 */
function hourlyPayoutKey(hour, category) {
    return `hourly:${hour}:${category}`;
}

function listingPayoutKey(listingId) {
    return `listing:${listingId}`;
}

/**
 * The seller's proceeds from a completed sale (#869), as opposed to the stock
 * `listingPayoutKey` returns when the listing expires unsold.
 *
 * Two credits against one listing id, and only one of them can ever happen —
 * `/market buy` and the expiry sweep both delete the listing to claim it. They
 * are still keyed apart rather than sharing a key, because the guard is a string
 * comparison on the user document and nothing there records which of the two
 * wrote it; a shared key would let a replay of one silently satisfy the other.
 */
function marketSalePayoutKey(listingId) {
    return `listing:${listingId}:sale`;
}

/**
 * The item a market buyer paid for (#873).
 *
 * The buyer's credit is the one write in a purchase whose outcome the unwind
 * has to *know* rather than assume: the listing is already deleted, so a credit
 * that committed and lost its response looks exactly like one that never ran,
 * and unwinding on that reading hands the item to the seller as well. Keyed, it
 * is a question that can be asked — `classifyUnmatchedPayout` reads the key off
 * the buyer's own document — so the unwind runs only when the item genuinely did
 * not arrive.
 *
 * Keyed by the listing rather than the interaction, and apart from the sale and
 * the unwind for the same reason those are apart from each other: one listing,
 * three credits that can each happen at most once, and a guard that is a string
 * comparison with nothing on it to say which of them wrote it.
 */
function listingPurchasePayoutKey(listingId) {
    return `listing:${listingId}:buyer`;
}

/**
 * The stock coming back out of a listing the seller cancelled (#873).
 *
 * Keyed apart from `listingPayoutKey` for the reason `marketSalePayoutKey` is:
 * only one of a cancel, a sale and an expiry can ever happen to a listing, since
 * all three claim it by deleting it — but the guard is a string comparison on
 * the user document with nothing on it to say which one wrote it, and a shared
 * key would let a replay of one silently satisfy another.
 */
function listingCancelPayoutKey(listingId) {
    return `listing:${listingId}:cancel`;
}

/**
 * The seller's stock coming back when a sale could not be finished (#873).
 *
 * `/market buy` deletes the listing before crediting the buyer, so a credit that
 * fails leaves the item in nobody's bag: the buyer's coins go back, and this is
 * what puts the item back where it came from.
 */
function listingUnwindPayoutKey(listingId) {
    return `listing:${listingId}:unwind`;
}

/**
 * The stock coming back when a listing could not be created (#873).
 *
 * Keyed by the interaction rather than a listing, because there is no listing:
 * this is the stock a `/market list` took out of the seller's bag and then could
 * not find a slot for.
 */
function listingCreateRefundPayoutKey(interactionId) {
    return `market:${interactionId}:relist`;
}

/**
 * A market buyer's coins coming back when the purchase could not be completed
 * (#873).
 *
 * Keyed by the interaction rather than the listing, exactly as
 * `transferRefundPayoutKey` is: the same buyer trying the same listing again a
 * second later is a different purchase and refunds separately, and the listing
 * id alone would collide across those attempts and drop the second refund.
 */
function marketRefundPayoutKey(interactionId) {
    return `market:${interactionId}:refund`;
}

/**
 * A gifted item coming back to its sender when the recipient's credit missed
 * (#873).
 *
 * Keyed by the interaction, like the coin transfer's refund beside it: the same
 * sender gifting the same item to the same person again is a different gift and
 * unwinds separately.
 */
function giftItemRollbackPayoutKey(interactionId) {
    return `gift:${interactionId}:rollback`;
}

/**
 * One player's stake coming back out of a duel escrow, or the pot going to its
 * winner (#873).
 *
 * `duelId` is `${challengerId}_${Date.now()}`, built when the challenge is
 * posted, so it names this duel and nothing else. The phase is in the key
 * because a duel can owe a player at two different moments — the escrow rollback
 * when the second stake could not be taken, and the settlement that pays the
 * winner — and the guard is a string comparison on the user document with
 * nothing on it to say which of the two wrote it. A shared key would let a
 * replay of the refund silently satisfy the payout.
 */
function duelPayoutKey(duelId, userId, phase) {
    return `duel:${duelId}:${phase}:${userId}`;
}

/**
 * One crew member's share of a group job — a `/heist` or a `/syndicate` raid
 * (#873).
 *
 * Both are keyed by the run's own id rather than by the guild and the hour: a
 * crew that fails a job and immediately runs another is owed two separate
 * shares, and a key that could not tell the runs apart would drop the second.
 */
function crewSharePayoutKey(jobId, userId) {
    return `crew:${jobId}:${userId}`;
}

/**
 * One claim on the progressive casino jackpot pool (#873).
 *
 * `claimId` is minted by the claim itself and written into the guild document
 * alongside the reset pool, so the live credit, the restart reconciler and
 * `payouts:replay` all rebuild the same string for the same pot. That is the
 * whole recovery design: the pool is claimed once and can then be credited from
 * three places at three different times, and the key is what makes all three
 * add up to one payment.
 *
 * Nothing about the win goes into it — not the guild's pool, not the amount, not
 * the winner. Two players can win identical pots minutes apart, and a key built
 * from what they won would make the second look like a replay of the first.
 */
function jackpotPayoutKey(guildId, claimId) {
    return `jackpot:${guildId}:${claimId}`;
}

/**
 * The sender's refund when a coin transfer could not be completed (#868).
 *
 * Keyed by the interaction, which is the one identifier that names *this*
 * transfer: the same two users moving the same amount a second later is a
 * different transfer and must refund separately, so a key built from the pair
 * and the amount would collide and drop the second one.
 */
function transferRefundPayoutKey(interactionId) {
    return `transfer:${interactionId}:refund`;
}

module.exports = {
    weeklyChampionPayoutKey, hourlyPayoutKey, listingPayoutKey,
    marketSalePayoutKey, listingPurchasePayoutKey, listingCancelPayoutKey,
    listingUnwindPayoutKey,
    listingCreateRefundPayoutKey,
    marketRefundPayoutKey, transferRefundPayoutKey, giftItemRollbackPayoutKey,
    duelPayoutKey, crewSharePayoutKey,
    jackpotPayoutKey,
    payoutKeyGuard, payoutKeyAppendExpr, classifyUnmatchedPayout,
    creditCoinsOnce, grantItemOnce, isDuplicateKeyError,
    RETENTION_DAYS, RETENTION_MS, KEY_CAP,
};
