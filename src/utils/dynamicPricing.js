// Dynamic supply & demand pricing for shop items (issue #354)

const VOLATILITY_FACTORS = {
    low:    { adjust: 0.10, decay: 0.05 },
    medium: { adjust: 0.18, decay: 0.10 },
    high:   { adjust: 0.28, decay: 0.15 },
};

const HISTORY_CAP = 30;

// Ensure pricing fields are populated for every shop item. Returns true if mutated.
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

// Compute next price based on demand, clamped to ±band of basePrice.
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

// The per-tick decay as a plain multiplier, so a caller can hand it to Mongo's
// `$mul` and let the decay apply to whatever the stored score is at write time
// rather than to the value it happened to read a moment earlier. Buys `$inc`
// this field concurrently (see commands/economy/shop.js), and a decayed value
// written back with `$set` would swallow any that landed in between.
function demandDecayFactor(volatility = 'medium') {
    const cfg = VOLATILITY_FACTORS[volatility] || VOLATILITY_FACTORS.medium;
    return 1 - cfg.decay;
}

// Decay demand toward zero (oversupply if negative, demand if positive).
function decayDemand(item, volatility = 'medium') {
    return (item.demandScore ?? 0) * demandDecayFactor(volatility);
}

// Price history is appended by the recalc job's `$push`/`$slice: -HISTORY_CAP`
// write rather than by rebuilding the array in JS, so the cap is enforced by the
// database. HISTORY_CAP is exported for that write and for readers of the chart.

// Convenience: % change between currentPrice and basePrice for /market trends display.
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
