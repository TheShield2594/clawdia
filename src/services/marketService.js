/**
 * The player market's money mechanics: the expiry sweep (#931), and the writes
 * a purchase makes once the listing has been claimed (#873).
 *
 * `/market` lists, buys and cancels; this returns what nobody bought. It is
 * registered as a job in `services/scheduler/index.js`, which owns the cron
 * expression and runs it through `runJob`; nothing here schedules itself
 * (#611).
 *
 * The one scheduled job in the codebase that takes no Discord client: it posts
 * nothing, and is `deployment`-scoped for that reason — there is nothing for a
 * second shard to reach, so running it everywhere would only race the listing
 * claim.
 *
 * @module services/marketService
 */

const FailedJob = require('../models/FailedJob');
const { recordOwedPayout, owedSummary } = require('../utils/owedPayout');
const { creditCoinsOrOwe, grantItemsOrOwe } = require('../utils/creditOrOwe');
const {
    creditCoinsOnce, grantItemOnce, classifyUnmatchedPayout, listingPayoutKey,
    listingPurchasePayoutKey, listingUnwindPayoutKey, marketRefundPayoutKey,
    marketSalePayoutKey,
} = require('../utils/payoutKey');

/**
 * Return expired market listings to their sellers before the MongoDB TTL index
 * deletes them.
 *
 * TTL-deleted documents do not fire Mongoose hooks, so without this job an item
 * whose listing expired unclaimed would vanish from the economy permanently.
 *
 * "Before the TTL index deletes them" was not achievable until #867: the index
 * carried no grace period, MongoDB's TTL monitor wakes about once a minute, and
 * this runs every ten — so the monitor won nearly every race and the items were
 * gone before this job ever saw the listing. The grace is now a week
 * (models/MarketListing.js), which is what makes selecting on `expiresAt <= now`
 * here the claim it reads as rather than a hope.
 *
 * @returns {Promise<void>}
 */
async function returnExpiredMarketListings() {
    const MarketListing = require('../models/MarketListing');
    const BATCH_SIZE = 50;
    const now = new Date();
    let processed = 0;
    let failed = 0;
    // Of the failures, the ones that happened *after* the listing was deleted,
    // and so are owed rather than merely retried. A failure before the claim
    // leaves the listing in place for the next tick and is owed nothing, so it
    // counts toward `failed` and must stay out of the owed summary below —
    // `owedSummary` derives "how many were recorded" by subtraction, and a
    // pre-claim failure in that subtraction reports a queue entry that is not
    // there.
    let owedReturns = 0;
    let unrecordedReturns = 0;

    // Batched to avoid large memory spikes, and oldest first.
    //
    // The sort is not cosmetic. Without one MongoDB returns natural order,
    // which is an implementation detail and not insertion order — so a capped
    // tick took an arbitrary 50 of the expired listings, and a listing could be
    // passed over tick after tick while newer ones went ahead of it. Every
    // listing has a deadline now (#867): the TTL grace deletes it seven days
    // after it expires, whether or not the sweep ever chose it. Oldest first is
    // what turns "the backlog drains" into "no individual listing starves",
    // which is the claim the grace period is sized against.
    //
    // Free, as it happens: the sort key is the TTL index, so this walks that
    // index in order rather than sorting anything in memory.
    const expired = await MarketListing.find({ expiresAt: { $lte: now } })
        .sort({ expiresAt: 1 })
        .limit(BATCH_SIZE)
        .lean();

    // A full batch means the tick hit its cap — there may be more behind it, or
    // there may have been exactly fifty. Either way it is the state worth
    // saying out loud, because a *sustained* cap means listings are expiring
    // faster than 50 per ten minutes, and the backlog that builds is the thing
    // the TTL grace is sized against. It used to be invisible.
    if (expired.length === BATCH_SIZE) {
        console.warn(
            `[scheduler] returnExpiredMarketListings: batch capped at ${BATCH_SIZE} — there may be more expired ` +
            'listings waiting. Any are returned on later ticks, oldest first; a cap that persists for days is a ' +
            'backlog outliving the TTL grace, and the batch needs raising.',
        );
    }

    for (const listing of expired) {
        try {
            // Claim the listing by deleting it before crediting anything. The
            // listing document is the only record that this return is owed, so
            // whoever deletes it owns the credit: a second worker, or this job's
            // next tick after a crash, finds nothing and does nothing.
            //
            // Crediting first and deleting after inverts that — a delete that
            // fails leaves the listing to be found and credited again on the next
            // tick, minting items. Losing a return is recoverable from this log;
            // silently doubling one is not.
            const claimed = await MarketListing.findOneAndDelete({ _id: listing._id });
            if (!claimed) continue;

            // Return items to the seller in one atomic update — the match-then-push
            // it replaced could hand two expiring listings of the same item their
            // own slot each, stranding one of them.
            //
            // Keyed by the listing id (#807), so a return whose write committed
            // without its response reaching here is not applied twice by the
            // replay script. The listing is gone, so the id will never be reused.
            const payoutKey = listingPayoutKey(listing._id);
            let status = null;
            let creditErr = null;
            try {
                ({ status } = await grantItemOnce(
                    { userId: listing.sellerId, guildId: listing.guildId },
                    listing.itemId, listing.quantity, payoutKey,
                    { upsert: true },
                ));
            } catch (err) {
                creditErr = err;
            }

            // 'duplicate' means an earlier attempt already returned these items.
            // Counted with the successes: the seller has them, and recording the
            // return as owed would put it straight back on the replay queue.
            if (status === 'paid' || status === 'duplicate') {
                if (status === 'duplicate') {
                    console.warn(
                        `[scheduler] listing ${listing._id} was already returned under ${payoutKey} — not returned again`,
                    );
                }
                processed++;
                continue;
            }

            {
                // The listing is already deleted, so nothing will find this
                // again — which is why the credit is written down as owed
                // rather than left to a retry that will never come (#804).
                //
                // `upsert` is on above, so 'missing' cannot come back from a
                // seller who simply has no document; anything here is a real
                // failure or a concurrent write that beat the guard.
                failed++;
                owedReturns++;
                const reason = creditErr?.message ??
                    `return for ${listing.sellerId} in ${listing.guildId} matched nothing (${status})`;
                const recorded = await recordOwedPayout({
                    service: 'marketService',
                    jobName: 'returnExpiredMarketListings',
                    guildId: listing.guildId,
                    payload: {
                        kind:      'items',
                        userId:    listing.sellerId,
                        guildId:   listing.guildId,
                        itemId:    listing.itemId,
                        quantity:  listing.quantity,
                        listingId: String(listing._id),
                        payoutKey,
                    },
                    error: creditErr ?? new Error(reason),
                });
                if (!recorded) unrecordedReturns += 1;

                // After the record write, for the same reason as the weekly
                // credit in weeklyChampionService.
                console.error(
                    `[scheduler] listing ${listing._id} was claimed but crediting ` +
                    `${listing.quantity}x ${listing.itemId} to ${listing.sellerId} failed — ` +
                    `${recorded ? 'items owed, recorded for replay' : 'items owed and NOT recorded, must be returned by hand'}:`,
                    reason,
                );
                continue;
            }
        } catch (err) {
            // A failure before the claim — the listing is untouched, so the
            // next tick finds it again. Counted all the same: a sweep that
            // returned nothing must not report a healthy run.
            failed++;
            console.error(`[scheduler] returnExpiredMarketListings failed for listing ${listing._id}:`, err.message);
        }
    }

    if (processed > 0) {
        console.log(`[scheduler] returnExpiredMarketListings: returned items from ${processed} expired listing(s).`);
    }

    // Same reasoning as announceWeeklyChampions: the per-listing catches keep one
    // bad listing from stranding the batch, and would otherwise also keep the
    // whole batch failing off /health and out of the dead-letter queue.
    if (failed) {
        throw new Error(
            `${failed} of ${expired.length} expired listing(s) could not be returned` +
            (processed ? ` (${processed} were)` : '') +
            (unrecordedReturns ? ` — ${owedSummary(owedReturns, unrecordedReturns)}` : '')
        );
    }
}

/**
 * Hand the buyer the item they paid for, and say whether they actually have it.
 *
 * By the time this runs the listing is deleted, so this credit is the only copy
 * of the item that exists — which is what makes the *question* matter as much as
 * the write. A write that commits and loses its response is indistinguishable
 * from one that never ran, and unwinding on that reading hands the seller their
 * stock back while the buyer is holding it. That mints an item, and it is the
 * bound the pass that added the unwind left open.
 *
 * The key closes it. It is on the buyer's own document if the credit landed, so
 * a rejection is a question `classifyUnmatchedPayout` can answer rather than an
 * assumption the caller has to make.
 *
 * Three answers, not two, and the third is the point. A classification that
 * itself fails leaves the outcome genuinely unknown, and *both* guesses are
 * destructive: reading it as delivered loses the buyer's item, and reading it as
 * not delivered unwinds — which refunds the buyer's coins **and** hands the
 * seller their stock back, so a credit that had in fact landed leaves the buyer
 * holding a free item and the seller holding a second copy of it. Two items
 * minted, from the branch that exists to prevent one.
 *
 * So `indeterminate` is its own state, nothing is undone under it, and the
 * deferral is filed here rather than left to the caller. The buyer's credit is
 * keyed, which makes it the one thing in the flow that can be settled later
 * without knowing the answer now: `grantItemOnce` under the same key is a no-op
 * if the write landed and a grant if it did not, so `npm run payouts:replay`
 * reaches the right end either way. The sale stands in the meantime — the buyer
 * paid and the seller sold; only the delivery is outstanding.
 *
 * @returns {Promise<{delivered: boolean, indeterminate: boolean, owed: boolean, error: ?Error}>}
 */
async function creditPurchasedItem({ buyerId, guildId, listing, Model = require('../models/User') }) {
    const who = { userId: buyerId, guildId };
    const payoutKey = listingPurchasePayoutKey(listing._id);
    const answer = (delivered, error) => ({ delivered, indeterminate: false, owed: false, error });

    let unknownError;
    try {
        const { status } = await grantItemOnce(who, listing.itemId, listing.quantity, payoutKey, { Model });
        // 'missing' and 'unknown' are *definite* misses: `grantItemOnce` read the
        // document to say so, and the key would be on it if the write had landed.
        if (status === 'paid' || status === 'duplicate') return answer(true, null);
        return answer(false, new Error(`buyer credit matched nothing (${status})`));
    } catch (err) {
        try {
            const status = await classifyUnmatchedPayout(Model, who, payoutKey);
            if (status === 'duplicate') return answer(true, null);
            return answer(false, err);
        } catch (readErr) {
            unknownError = readErr;
        }
    }

    const owed = await recordOwedPayout({
        service: 'market',
        jobName: 'buyItemUnknown',
        guildId,
        payload: {
            kind:      'items',
            userId:    buyerId,
            guildId,
            itemId:    listing.itemId,
            quantity:  listing.quantity,
            listingId: String(listing._id),
            payoutKey,
        },
        error: unknownError,
    });
    console.error(
        `[market buy] listing ${listing._id}: cannot tell whether ${listing.quantity}x ${listing.itemId} ` +
        `reached ${buyerId} — ${owed ? 'recorded for replay under the purchase key' : 'NOT RECORDED'}:`,
        unknownError?.message,
    );
    return { delivered: false, indeterminate: true, owed, error: unknownError };
}

/**
 * Put a purchase back where it came from: the buyer's coins, and — when the
 * listing was already claimed — the seller's stock.
 *
 * Both halves used to be missing something. The refunds were bare `updateOne`
 * `$inc`s whose result nothing read, so a buyer whose document had gone was told
 * their coins were back over a balance that was still short; one swallowed its
 * rejection and the other did not catch at all. And the stock had nowhere to go
 * at all: the listing row is the only place a listed item exists, so refunding
 * the buyer alone left it in nobody's inventory — destroyed, silently, with the
 * seller never told.
 *
 * `refundKey` names the purchase rather than the listing, because the same buyer
 * trying the same listing again a second later is a different purchase and
 * refunds separately; the stock is keyed to the listing, which is deleted and so
 * cannot be reused. The stock is returned to the seller's bag rather than by
 * recreating the listing — their five slots may have filled while the purchase
 * was in flight.
 *
 * `returnStock` is false for the path where the listing was never claimed: the
 * item is still in a live listing, and returning it as well would duplicate it.
 *
 * @returns {Promise<{refund: object, returned: ?object}>}
 */
async function unwindPurchase({
    buyerId, sellerId, guildId, listing, totalCost, refundKey, jobName, returnStock = true,
}) {
    const refund = await creditCoinsOrOwe({ userId: buyerId, guildId }, totalCost, {
        payoutKey: marketRefundPayoutKey(refundKey),
        service: 'market',
        jobName,
    });

    if (!returnStock) return { refund, returned: null };

    const returned = await grantItemsOrOwe(
        { userId: sellerId, guildId }, listing.itemId, listing.quantity,
        {
            payoutKey: listingUnwindPayoutKey(listing._id),
            service: 'market',
            jobName: 'buyUnwindStock',
            extra: { listingId: String(listing._id) },
        },
    );
    if (!returned.granted) {
        console.error(
            `[market buy] listing ${listing._id} was claimed but the sale failed and returning ` +
            `${listing.quantity}x ${listing.itemId} to ${sellerId} failed too — ` +
            `${returned.owed ? 'items owed, recorded for replay' : 'items owed and NOT recorded'}`,
        );
    }
    return { refund, returned };
}

/**
 * The seller's proceeds from a completed sale, and the balance to file the
 * ledger row against (#869).
 *
 * By the time this runs the buyer has paid, the item has moved and the listing
 * is deleted, so there is nothing left to retry against. It used to be an
 * unguarded write with both failure modes swallowed: a `null` return — a seller
 * with no user document — was ignored and logged as `balance: 0`, and a throw
 * escaped the purchase entirely with the buyer already charged.
 *
 * Keyed by the listing, which the purchase has just deleted and so cannot reuse,
 * making the credit exactly-once: a write that committed without its response
 * arriving is not paid again by `npm run payouts:replay`. Anything that still
 * will not land is written down as owed, which is what the expiry sweep does
 * with a return it cannot make.
 *
 * `balance` is read back rather than assumed, and is `null` only when it could
 * not be read at all. 'duplicate' is a success whose response was lost on an
 * earlier attempt — the coins are there — but it comes back with no document,
 * and a failure has none either, so the figure comes from a second read.
 *
 * That read can fail too, and the previous version answered `0` for it: a number
 * nobody observed, written into the `market_sell` ledger row as though it had
 * been. That is the same untruth as a refund that did not happen, in the one
 * place an operator goes looking when the coins are in question. A read that
 * *succeeds* and finds no seller document is a different thing — it is an
 * answer, and zero is the true one — so that case still files its row, which is
 * what #869 added it for.
 *
 * @returns {Promise<{paid: boolean, owed: boolean, balance: ?number, payoutKey: string}>}
 */
async function payListingSeller({ sellerId, guildId, listing, amount, Model = require('../models/User') }) {
    const who = { userId: sellerId, guildId };
    const payoutKey = marketSalePayoutKey(listing._id);

    let status = null;
    let doc = null;
    let error = null;
    try {
        ({ status, doc } = await creditCoinsOnce(who, amount, payoutKey, {
            Model, projection: { balance: 1 },
        }));
    } catch (err) {
        error = err;
    }

    const paid = status === 'paid' || status === 'duplicate';
    // Three outcomes, not two. The write's own projection answers first; failing
    // that, a read answers; and only a read that *threw* leaves the figure
    // genuinely unknown. A read that succeeds and finds no seller document is an
    // answer — they hold nothing — and the ledger row it produces is true.
    let balance = doc?.balance ?? null;
    if (balance === null) {
        balance = await Model.findOne(who, { balance: 1 }).lean()
            .then(fresh => fresh?.balance ?? 0)
            .catch(() => null);
    }

    if (paid) return { paid, owed: false, balance, payoutKey };

    const reason = error?.message ?? `credit for ${sellerId} in ${guildId} matched nothing (${status})`;
    const owed = await recordOwedPayout({
        service: 'market',
        jobName: 'buyListing',
        guildId,
        payload: {
            kind:      'coins',
            userId:    sellerId,
            guildId,
            amount,
            listingId: String(listing._id),
            payoutKey,
        },
        error: error ?? new Error(reason),
    });
    console.error(
        `[market buy] listing ${listing._id} sold but crediting ${amount} to ${sellerId} failed — ` +
        `${owed ? 'recorded as owed' : 'NOT RECORDED'}:`, reason,
    );
    return { paid, owed, balance, payoutKey };
}

/**
 * Write down a listing claim whose outcome nobody can establish.
 *
 * `findOneAndDelete` is the write that claims a listing for a purchase, and a
 * rejection from it says nothing about whether it committed. Re-reading the
 * listing narrows it to two worlds and cannot separate them: the row is gone
 * either because this delete landed and the item is now in nobody's bag, or
 * because a concurrent buyer's delete landed and the item is rightfully theirs.
 *
 * So nothing is granted. Returning the stock would mint an item in the second
 * world, and this file's own rule — losing a return is recoverable from a
 * record, silently doubling one is not — decides that. What the previous version
 * got wrong is what "recoverable from a record" means: it wrote a console line,
 * which is not a record. An operator had to already be reading logs at the right
 * minute to ever learn the item existed.
 *
 * This is a plain `FailedJob` and deliberately **not** `recordOwedPayout`. That
 * helper suffixes the job name with `.owed`, which is what puts a payload in
 * front of `npm run payouts:replay` — and replaying this one would grant the
 * stock unconditionally, which is exactly the second world's duplicate. It needs
 * a human to decide, so it is filed where a human looks and nowhere a script
 * will act on it unattended.
 *
 * Never throws: it runs while a purchase is being unwound and must not abandon
 * the refund that follows it.
 *
 * @returns {Promise<boolean>} whether the record was written
 */
async function recordAmbiguousClaim({ listing, buyerId, guildId, stillListed, error }) {
    return FailedJob.create({
        service:  'market',
        jobName:  'buyClaimAmbiguous',
        guildId,
        payload: {
            listingId:    String(listing._id),
            sellerId:     listing.sellerId,
            buyerId,
            itemId:       listing.itemId,
            quantity:     listing.quantity,
            stillListed,
            // Spelled out because whoever reads this is deciding between two
            // worlds and needs to know which question to ask.
            adjudicate: stillListed
                ? 'The listing survived, so the delete did not land: the buyer was refunded and nothing else is owed.'
                : `The listing is gone. If no completed purchase exists for it — check for a market_sell row or the `
                  + `${marketSalePayoutKey(listing._id)} key on the seller — then ${listing.quantity}x ${listing.itemId} `
                  + `is owed back to ${listing.sellerId}. If one does exist, the item went to that buyer and nothing is owed.`,
        },
        errorMessage: error?.message ?? 'listing claim rejected with an unknown outcome',
        errorStack:   error?.stack ?? null,
        lastAttemptAt: new Date(),
    }).then(() => true).catch(err => {
        console.error('[market buy] could not record the ambiguous listing claim:', err?.message);
        return false;
    });
}

module.exports = {
    returnExpiredMarketListings, creditPurchasedItem, unwindPurchase, payListingSeller,
    recordAmbiguousClaim,
};
