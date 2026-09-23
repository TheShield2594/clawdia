'use strict';

// Constants and small helpers every /market subcommand shares.

const { RARITY_ORDER } = require('../../../data/defaultShopItems');

const MAX_LISTINGS_PER_USER = 5;
// The slots a seller's listings occupy, 1-based. Each listing carries the one it
// holds and the unique index on { guildId, sellerId, slot } enforces it — see
// createListingInFreeSlot and models/MarketListing.js.
const LISTING_SLOTS = Array.from({ length: MAX_LISTINGS_PER_USER }, (_, i) => i + 1);
const LISTING_TTL_MS        = 48 * 3_600_000;
const MARKET_FEE_RATE       = 0.05;
const MIN_PRICE_PER_ITEM    = 10;
const PAGE_SIZE             = 10;
const CONFIRM_BUY_THRESHOLD = 500;

const SORT_RARITY = 'rarity';
const SORT_PRICE  = 'price';

// The forge mints Legendary, a tier above the shop's five; rank it on top
// rather than letting it fall to the bottom with the unknowns.
const RARITY_RANK = Object.fromEntries([...RARITY_ORDER, 'Legendary'].map((r, i) => [r, i]));

// Browse loads at most this many listings, cheapest first.
const BROWSE_LIMIT = 200;

// A listing past its expiry is the sweep's to hand back, not anyone's to buy
// (#873, pass 21). The sweep claims 50 a tick, so under a backlog an expired
// listing could sit buyable for days; every read a buyer sees filters it out.
const live = () => ({ expiresAt: { $gt: new Date() } });

/** `🍀 **Lucky Charm**` — how an item is named inside a sentence. */
const itemLabel = meta => `${meta.emoji} **${meta.name}**`;

module.exports = {
    MAX_LISTINGS_PER_USER, LISTING_SLOTS, LISTING_TTL_MS, MARKET_FEE_RATE,
    MIN_PRICE_PER_ITEM, PAGE_SIZE, CONFIRM_BUY_THRESHOLD,
    SORT_RARITY, SORT_PRICE, RARITY_RANK, itemLabel, BROWSE_LIMIT, live,
};
