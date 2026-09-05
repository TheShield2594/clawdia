/**
 * The player market's expiry sweep (#931).
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

const { recordOwedPayout, owedSummary } = require('../utils/owedPayout');
const { grantItemOnce, listingPayoutKey } = require('../utils/payoutKey');

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
            (unrecordedReturns ? ` — ${owedSummary(failed, unrecordedReturns)}` : '')
        );
    }
}

module.exports = { returnExpiredMarketListings };
