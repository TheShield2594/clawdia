'use strict';

/**
 * Price hints for `/market list`.
 *
 * The market has no buy-back: an item's price is whatever another player will
 * pay. That keeps coins from being minted out of items, but it leaves a seller
 * guessing, and a guess that is ten times too high is a listing that sits for
 * 48 hours and comes back. This gives them something to price against, in
 * order of how much it says about this server's market right now:
 *
 *   1. what the item last sold for here, and the median of its recent sales
 *   2. the cheapest listing of it someone else has up right now
 *   3. what the game itself puts on it — the shop price, the relic's payout,
 *      or what its rarity cost to forge (`describeItem().value`)
 *
 * Read-only and batched — two queries however many items are asked about — so
 * it is affordable inside an autocomplete handler.
 */

const MarketSale    = require('../models/MarketSale');
const MarketListing = require('../models/MarketListing');

// How many recent sales the median is taken over.
const RECENT_SALES = 10;

/** Record a completed sale. Fire-and-forget: a lost price point never fails a purchase. */
function recordSale({ guildId, itemId, quantity, pricePerUnit }) {
    return MarketSale.create({ guildId, itemId, quantity, pricePerUnit })
        .catch(err => console.error('[market] failed to record sale price:', err?.message ?? err));
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Set once a server has refused `$firstN`, so the fallback is taken directly
// from then on instead of failing a query first on every keystroke.
let firstNUnsupported = false;

/**
 * Each item's last sale and its RECENT_SALES most recent prices.
 *
 * `$firstN` (MongoDB 5.2+) keeps at most RECENT_SALES prices per item while
 * grouping. The deployment runs mongo:7, but a self-hosted server can be older
 * and would reject the operator; that one case falls back to `$push` + `$slice`,
 * which gathers the item's whole 90-day history before trimming it — correct,
 * just heavier — rather than losing every price hint.
 */
async function saleHistory(guildId, ids) {
    const head = [
        { $match: { guildId, itemId: { $in: ids } } },
        { $sort: { soldAt: -1 } },
    ];
    const group = prices => ({ $group: {
        _id: '$itemId',
        lastPrice: { $first: '$pricePerUnit' },
        lastSoldAt: { $first: '$soldAt' },
        prices,
    } });

    if (!firstNUnsupported) {
        try {
            return await MarketSale.aggregate([...head, group({ $firstN: { input: '$pricePerUnit', n: RECENT_SALES } })]);
        } catch (err) {
            // 15952: unknown group operator. Anything else is a real failure.
            if (err?.code !== 15952 && !/firstN/.test(err?.message ?? '')) throw err;
            firstNUnsupported = true;
        }
    }
    return MarketSale.aggregate([
        ...head,
        group({ $push: '$pricePerUnit' }),
        { $project: { lastPrice: 1, lastSoldAt: 1, prices: { $slice: ['$prices', RECENT_SALES] } } },
    ]);
}

/**
 * Market figures for each of `itemIds` in one guild.
 *
 * @param {string}   guildId
 * @param {string[]} itemIds
 * @param {object}   [options]
 * @param {string}   [options.excludeSellerId] leave this seller's own listings
 *                   out of "cheapest listed", so a seller is not shown their
 *                   own price back as the going rate
 * @returns {Promise<Map<string, {lastPrice, lastSoldAt, medianPrice, sales, lowestListed}>>}
 *          Items with no history and no listings are absent. Never rejects — a
 *          missing hint is cosmetic.
 */
async function priceSnapshot(guildId, itemIds, { excludeSellerId = null } = {}) {
    const ids = [...new Set(itemIds ?? [])];
    const out = new Map();
    if (!ids.length) return out;

    const entry = id => {
        if (!out.has(id)) out.set(id, { lastPrice: null, lastSoldAt: null, medianPrice: null, sales: 0, lowestListed: null });
        return out.get(id);
    };

    const listingQuery = { guildId, itemId: { $in: ids } };
    if (excludeSellerId) listingQuery.sellerId = { $ne: excludeSellerId };

    const [sales, listings] = await Promise.all([
        saleHistory(guildId, ids)
            .catch(err => { console.error('[market] sale history lookup failed:', err?.message ?? err); return []; }),
        // At most five listings per seller, so this is bounded without a limit.
        MarketListing.find(listingQuery, 'itemId pricePerUnit').lean()
            .catch(err => { console.error('[market] listing price lookup failed:', err?.message ?? err); return []; }),
    ]);

    for (const row of sales ?? []) {
        const e = entry(row._id);
        e.lastPrice   = row.lastPrice;
        e.lastSoldAt  = row.lastSoldAt;
        e.medianPrice = median(row.prices ?? []);
        e.sales       = (row.prices ?? []).length;
    }
    for (const l of listings ?? []) {
        const e = entry(l.itemId);
        if (e.lowestListed === null || l.pricePerUnit < e.lowestListed) e.lowestListed = l.pricePerUnit;
    }
    return out;
}

// What the game's own number on an item is called, by where it came from.
const REFERENCE_LABELS = { shop: 'shop price', relic: 'relic value', forged: 'forge cost' };

const coins = (currency, n) => `${currency}${Math.round(n).toLocaleString()}`;

// Sales needed before the median, rather than the latest sale, is the headline.
// Below this there is no middle to speak of. The median takes one odd sale out
// of the headline; it does not stop a determined seller, who could plant a
// majority of a thin history through alts (paying the 5% fee each time). The
// price check on the listing receipt shows the last sale and the median side
// by side, so an odd one is visible there.
const MEDIAN_AFTER = 3;

/**
 * The one-line hint for the picker: the best single figure there is.
 * `meta` is the item's `describeItem` result. Empty when nothing is known.
 */
function shortHint(snapshot, meta, currency) {
    if (snapshot?.sales >= MEDIAN_AFTER) return `sells for ~${coins(currency, snapshot.medianPrice)}`;
    if (snapshot?.lastPrice) return `last sold ${coins(currency, snapshot.lastPrice)}`;
    if (snapshot?.lowestListed) return `listed from ${coins(currency, snapshot.lowestListed)}`;
    const label = REFERENCE_LABELS[meta?.kind];
    if (label && meta.value > 0) return `${label} ${coins(currency, meta.value)}`;
    return '';
}

/**
 * The fuller "price check" for the listing receipt, set against the price the
 * seller just chose. Null when there is nothing to compare with.
 */
function priceCheck(snapshot, meta, currency, price) {
    const lines = [];
    if (snapshot?.lastPrice) {
        const when = snapshot.lastSoldAt ? ` <t:${Math.floor(new Date(snapshot.lastSoldAt).getTime() / 1000)}:R>` : '';
        lines.push(`Last sold for **${coins(currency, snapshot.lastPrice)}**/ea${when}`);
        if (snapshot.sales > 1) lines.push(`Median of the last ${snapshot.sales} sales: **${coins(currency, snapshot.medianPrice)}**/ea`);
    }
    if (snapshot?.lowestListed) lines.push(`Cheapest other listing: **${coins(currency, snapshot.lowestListed)}**/ea`);
    const label = REFERENCE_LABELS[meta?.kind];
    if (label && meta.value > 0) lines.push(`${label[0].toUpperCase()}${label.slice(1)}: ${coins(currency, meta.value)}`);
    if (!lines.length) return null;

    // Judged against real sales first, then the game's own figure. Only the
    // clear cases get a verdict: a price within a factor of two says nothing.
    const benchmark = snapshot?.medianPrice ?? snapshot?.lastPrice ?? (meta?.value > 0 ? meta.value : null);
    if (benchmark) {
        if (price >= benchmark * 2)       lines.push('⚠️ Well above that — it may sit unsold until it expires.');
        else if (price <= benchmark / 2)  lines.push('💸 Well below that — expect it to go fast.');
    }
    return lines.join('\n');
}

module.exports = { recordSale, priceSnapshot, shortHint, priceCheck, median, RECENT_SALES };
