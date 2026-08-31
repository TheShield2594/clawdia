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

// TTL index for automatic expiry cleanup (MongoDB removes docs after expiresAt)
marketListingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
