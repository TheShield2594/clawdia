'use strict';

const { Schema, model } = require('mongoose');

/**
 * One completed `/market` sale, kept for price history.
 *
 * `/market list` asks the seller for a price and, until this existed, gave them
 * nothing to price against: a listing is deleted when it sells, and the
 * `market_buy` ledger row records the total without the quantity. These rows are
 * what the price hint reads — the last price an item went for, and the median
 * of its recent sales.
 *
 * Deliberately anonymous: no buyer or seller id, just what changed hands and
 * for how much. A price is a fact about the server's market, not about a
 * member, so there is nothing here for an access or erasure request to find
 * (see tests/userDataRegistryDrift.test.js) and nothing to leak through a hint.
 */
const marketSaleSchema = new Schema({
    guildId:      { type: String, required: true },
    itemId:       { type: String, required: true },
    quantity:     { type: Number, required: true, min: 1 },
    pricePerUnit: { type: Number, required: true, min: 1 },
    soldAt:       { type: Date,   default: Date.now },
});

// The price hint's read: one guild's sales of a handful of items, newest first.
marketSaleSchema.index({ guildId: 1, itemId: 1, soldAt: -1 });

// Same 90 days the Transaction ledger keeps. A price from last season says
// little about this one.
marketSaleSchema.index({ soldAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = model('MarketSale', marketSaleSchema);
