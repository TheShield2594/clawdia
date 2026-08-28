// Dynamic supply & demand pricing for shop items (issue #354)

const VOLATILITY_FACTORS = {
    low:    { adjust: 0.10, decay: 0.05 },
    medium: { adjust: 0.18, decay: 0.10 },
    high:   { adjust: 0.28, decay: 0.15 },
};

const HISTORY_CAP = 30;

/**
 * Backfill `basePrice`, `currentPrice` and `demandScore` on shop items that
 * predate dynamic pricing, so the rest of this module can assume they exist.
 *
 * Mutates the items in place and reports whether it changed anything, so a
 * caller can skip the save when it did not.
 *
 * @param {Array<{price: number, basePrice?: number, currentPrice?: number,
 *   demandScore?: number}>} shopItems mutated in place
 * @returns {boolean} true if any field was filled in
 */
function ensurePricingFields(shopItems) {
    let changed = false;
    for (const item of shopItems) {
        if (item.basePrice == null) {
            item.basePrice = item.price;
            changed = true;
        }
        if (item.currentPrice == null) {
            item.currentPrice = item.price;
            changed = true;
        }
        if (item.demandScore == null) {
            item.demandScore = 0;
            changed = true;
        }
    }
    return changed;
}

/**
 * The price this item should move to on the next recalculation tick.
 *
 * Demand is put through `tanh` so extreme demand asymptotes rather than running
 * away, scaled to at most `band` either side of `basePrice`; the result is then
 * approached 60% of the way from the current price rather than jumped to, which
 * is what keeps the `/market` price chart readable. Never returns less than 1.
 *
 * @param {{price: number, basePrice?: number, currentPrice?: number,
 *   demandScore?: number}} item
 * @param {number} band the maximum swing either side of base, as a fraction
 *   (`0.5` is ±50%); falsy is treated as 0.5
 * @param {'low'|'medium'|'high'} [volatility] how hard demand pushes;
 *   unrecognised values fall back to medium
 * @returns {number} a whole number of coins
 */
function nextPrice(item, band, volatility = 'medium') {
    const cfg = VOLATILITY_FACTORS[volatility] || VOLATILITY_FACTORS.medium;
    const base = item.basePrice ?? item.price;
    const demand = item.demandScore ?? 0;
    // Sigmoid-ish curve so extreme demand asymptotes
    const swing = Math.tanh(demand * cfg.adjust / 10) * (band || 0.5);
    const target = Math.max(1, Math.round(base * (1 + swing)));
    // Step toward target instead of jumping; smooths price chart
    const cur = item.currentPrice ?? base;
    return Math.round(cur + (target - cur) * 0.6);
}

/**
 * The per-tick decay as a plain multiplier, so a caller can hand it to Mongo's
 * `$mul` and let the decay apply to whatever the stored score is at write time
 * rather than to the value it happened to read a moment earlier. Buys `$inc`
 * this field concurrently (see commands/economy/shop.js), and a decayed value
 * written back with `$set` would swallow any that landed in between.
 *
 * @param {'low'|'medium'|'high'} [volatility] unrecognised values fall back to
 *   medium
 * @returns {number} between 0 and 1
 */
function demandDecayFactor(volatility = 'medium') {
    const cfg = VOLATILITY_FACTORS[volatility] || VOLATILITY_FACTORS.medium;
    return 1 - cfg.decay;
}

/**
 * This item's demand score after one tick of decay toward zero.
 *
 * Prefer `demandDecayFactor` and `$mul` for the write — see the note there.
 * This is for callers that need the number itself, such as a preview.
 *
 * @param {{demandScore?: number}} item
 * @param {'low'|'medium'|'high'} [volatility]
 * @returns {number} signed: negative is oversupply, positive is demand
 */
function decayDemand(item, volatility = 'medium') {
    return (item.demandScore ?? 0) * demandDecayFactor(volatility);
}

// Price history is appended by the recalc job's `$push`/`$slice: -HISTORY_CAP`
// write rather than by rebuilding the array in JS, so the cap is enforced by the
// database. HISTORY_CAP is exported for that write and for readers of the chart.

/**
 * How far an item has moved from its base price, and the glyph `/market` shows
 * for it: 🔥 at +15%, 📈 at +5%, 🧊 at -15%, 📉 at -5%, `·` in between.
 *
 * @param {{price: number, basePrice?: number, currentPrice?: number}} item
 * @returns {{pct: number, arrow: string}} `{pct: 0, arrow: '·'}` for an item
 *   with no base price to compare against
 */
function trendBucket(item) {
    const base = item.basePrice ?? item.price;
    const cur  = item.currentPrice ?? base;
    if (!base) return { pct: 0, arrow: '·' };
    const pct = ((cur - base) / base) * 100;
    let arrow = '·';
    if (pct >= 15) arrow = '🔥';
    else if (pct >= 5) arrow = '📈';
    else if (pct <= -15) arrow = '🧊';
    else if (pct <= -5) arrow = '📉';
    return { pct, arrow };
}

module.exports = {
    VOLATILITY_FACTORS,
    HISTORY_CAP,
    ensurePricingFields,
    nextPrice,
    demandDecayFactor,
    decayDemand,
    trendBucket,
};
