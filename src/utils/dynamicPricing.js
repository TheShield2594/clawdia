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

// Decay demand toward zero (oversupply if negative, demand if positive).
function decayDemand(item, volatility = 'medium') {
    const cfg = VOLATILITY_FACTORS[volatility] || VOLATILITY_FACTORS.medium;
    return (item.demandScore ?? 0) * (1 - cfg.decay);
}

// Record a price-history entry and trim to cap.
function pushHistory(item, at = new Date()) {
    if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
    item.priceHistory.push({
        at,
        price: item.currentPrice ?? item.basePrice ?? item.price,
        demandScore: item.demandScore ?? 0,
    });
    if (item.priceHistory.length > HISTORY_CAP) {
        item.priceHistory.splice(0, item.priceHistory.length - HISTORY_CAP);
    }
}

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
    decayDemand,
    pushHistory,
    trendBucket,
};
