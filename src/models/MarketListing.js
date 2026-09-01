const { Schema, model } = require('mongoose');

const marketListingSchema = new Schema({
    guildId:      { type: String, required: true },
    sellerId:     { type: String, required: true },
    itemId:       { type: String, required: true },
    quantity:     { type: Number, required: true, min: 1 },
    pricePerUnit: { type: Number, required: true, min: 1 },
    listedAt:     { type: Date, default: Date.now },
    expiresAt:    { type: Date, required: true },

    // Which of the seller's MAX_LISTINGS_PER_USER slots this listing occupies,
    // 1-based. It exists so the per-seller cap can be a property of the data
    // rather than of a count read a moment before the insert (#926): two
    // concurrent `/market list` calls both passed that count and both inserted.
    //
    // A slot is not a counter kept alongside the listings — it is carried by the
    // listing itself, so cancelling, selling or expiring one frees its slot by
    // deleting the row. There is nothing to decrement, and so nothing that can
    // drift and cost a seller a slot they are not using.
    //
    // Deliberately not required and with no default: rows written before this
    // field existed have no slot, and the index below skips them rather than
    // treating them all as duplicates of one another. They are gone within the
    // 48-hour listing TTL.
    slot:         { type: Number, min: 1 },
});

// How long an expired listing survives past `expiresAt` before MongoDB removes
// the document outright. It is not a cleanup schedule — it is the margin the
// sweep gets to run first.
//
// This was 0 (#867), and 0 loses items on the ordinary expiry path. MongoDB's
// TTL monitor wakes about once a minute, so a listing was hard-deleted within
// roughly a minute of expiring. `returnExpiredMarketListings` — the job that
// gives the seller their items back, and the only thing that does — runs every
// ten minutes and selects on `expiresAt <= now`. The TTL monitor therefore won
// the race for almost every expiry, and a TTL delete fires no Mongoose hook: no
// items returned, no owed-payout record, nothing logged. The seller's stock
// simply ceased to exist, on the success path, silently.
//
// Seven days rather than something just over the sweep interval. The sweep
// claims at most 50 listings per tick (7,200 a day), so a deployment that
// expires faster than that builds a backlog, and the grace has to outlast the
// backlog and not merely one tick. Nothing is kept alive by this that the sweep
// would have deleted anyway: the sweep deletes each listing itself as it claims
// it, so in normal operation the TTL monitor finds nothing left to remove. What
// it removes is what the sweep never reached — and a week is long enough that
// the sweep's own dead-letter alarms fire well before this destroys anything.
//
// The sweep's `expiresAt <= now` filter is deliberately left alone: it is what
// makes the sweep claim a listing the moment it expires, hours before the TTL
// monitor is entitled to look at it.
const EXPIRED_LISTING_GRACE_SECONDS = 7 * 24 * 60 * 60;

// Changing `expireAfterSeconds` on an index that already exists is not
// something declaring it here does — Mongoose issues a createIndex that comes
// back IndexOptionsConflict, leaving the old zero-grace index in place, still
// deleting listings. Migration 021_market_listing_ttl_grace applies it with
// collMod to databases that already built it.
marketListingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: EXPIRED_LISTING_GRACE_SECONDS });
marketListingSchema.index({ guildId: 1, itemId: 1, pricePerUnit: 1 });
marketListingSchema.index({ guildId: 1, sellerId: 1 });

// The cap itself. A unique key on the seller's slot is what makes
// MAX_LISTINGS_PER_USER true under concurrency: the loser of a race gets an
// E11000 and picks another slot, and a seller with every slot taken has nowhere
// left to insert. The partial filter keeps it to rows that actually carry a
// slot — a compound sparse index would still index a legacy row (sparse skips a
// document only when it has none of the keys, and these rows have guildId and
// sellerId), and every such row would collide on `slot: null`.
marketListingSchema.index(
    { guildId: 1, sellerId: 1, slot: 1 },
    { name: 'idx_market_seller_slot', unique: true, partialFilterExpression: { slot: { $gte: 1 } } },
);

module.exports = model('MarketListing', marketListingSchema);
module.exports.EXPIRED_LISTING_GRACE_SECONDS = EXPIRED_LISTING_GRACE_SECONDS;
