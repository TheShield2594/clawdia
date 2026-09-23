'use strict';

/**
 * How a market listing reads in `/market browse` and the purchase prompt.
 *
 * Split out of the command (#873, pass 21) when the listing's item started being
 * described by `describeItem` rather than by the built-in catalogue alone. The
 * catalogue only knows the default shop items, so every other item on the
 * market fell back to `getItemRarity(itemId, pricePerUnit)` — rarity bucketed by
 * the seller's own asking price. A Common relic listed at 10,000 each was shown
 * as Mythic, and sorted with the Mythics. The rarity now comes from the item:
 * the catalogue, the guild's shop row at the guild's price, the relic table, or
 * the forged item's own row.
 */

const { describeItem } = require('../utils/itemDisplay');
const { EFFECT_CONFIGS } = require('../data/effectConfigs');
const { RARITY_ORDER } = require('../data/defaultShopItems');

// Forged items mint a tier above Mythic, so it sorts after it.
const RARITY_RANK = Object.fromEntries([...RARITY_ORDER, 'Legendary'].map((r, i) => [r, i]));

/** The listing's item as a player sees it, with the effect emoji the shop uses. */
function describeListing(listing, { shopItems = [], aiItems = {} } = {}) {
    const meta = describeItem(listing.itemId, { shopItems, aiItem: aiItems[listing.itemId] ?? null });
    const emoji = EFFECT_CONFIGS[listing.itemId]?.emoji ?? meta.emoji;
    return { ...meta, emoji, displayName: `${emoji} ${meta.name}`.trim() };
}

/** Rarity tier first (Common first), then unit price within the tier. */
function byRarityThenPrice(context) {
    const rank = l => RARITY_RANK[describeListing(l, context).rarity] ?? 0;
    return (a, b) => (rank(a) - rank(b)) || (a.pricePerUnit - b.pricePerUnit);
}

/** One listing's line in the browse embed. */
function formatListingLine(listing, { currency, repMap, tagMap, context }) {
    const sellerTag = tagMap.get(listing.sellerId) ?? 'Unknown';
    const rep       = repMap.get(listing.sellerId) ?? '🆕 first listing';
    const total     = listing.pricePerUnit * listing.quantity;
    const item      = describeListing(listing, context);
    const lore      = item.lore ? `\n  *${item.lore.slice(0, 80)}${item.lore.length > 80 ? '…' : ''}*` : '';
    const rarity    = item.rarity ?? 'Unknown';
    return `\`${String(listing._id).slice(-6)}\`  @${sellerTag} *(${rep})*\n`
        + `**${listing.quantity}x ${item.displayName}** — ${currency}${listing.pricePerUnit.toLocaleString()}/ea  `
        + `*(${currency}${total.toLocaleString()} total)*  · ${rarity}${lore}`;
}

module.exports = { describeListing, byRarityThenPrice, formatListingLine, RARITY_RANK };
