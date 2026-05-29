const { Schema, model } = require('mongoose');

const marketListingSchema = new Schema({
    guildId:      { type: String, required: true },
    sellerId:     { type: String, required: true },
    itemId:       { type: String, required: true },
    quantity:     { type: Number, required: true, min: 1 },
    pricePerUnit: { type: Number, required: true, min: 1 },
    listedAt:     { type: Date, default: Date.now },
    expiresAt:    { type: Date, required: true },
});

// TTL index for automatic expiry cleanup (MongoDB removes docs after expiresAt)
marketListingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
marketListingSchema.index({ guildId: 1, itemId: 1, pricePerUnit: 1 });
marketListingSchema.index({ guildId: 1, sellerId: 1 });

module.exports = model('MarketListing', marketListingSchema);
