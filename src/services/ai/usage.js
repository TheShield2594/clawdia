const AIUsage = require('../../models/AIUsage');
const { providers } = require('./providers');

// Pricing tables live on each provider (provider.pricing); this module owns
// cost estimation and the per-guild usage ledger.

function estimateCost(provider, model, inputTokens, outputTokens) {
    const table = providers.get(provider)?.pricing || [];
    const row = table.find(r => r.match.test(model || ''));
    if (!row) return null;
    return (inputTokens * row.in + outputTokens * row.out) / 1_000_000;
}

function utcDayString(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function utcMonthString(date = new Date()) {
    return date.toISOString().slice(0, 7);
}

// ── The monthly ceiling's read side ──────────────────────────────────────────
//
// The ledger below has always been record-only: every call writes to it and
// nothing ever read it back as a limit. Enforcing a per-guild monthly ceiling
// means reading it on the way *in*, at the same chokepoint the sliding windows
// are applied — and that chokepoint is synchronous by design (see the comment
// on streamCompletion: the slot has to be spent when the caller asks for the
// stream, not when it pulls the first chunk).
//
// So the month's totals are cached and read synchronously, with two things
// keeping the cached number honest between refreshes:
//
//   * every completed call adds its own tokens to the cached total the moment
//     it is recorded, so the cache tracks this process's own spend exactly;
//   * the total is re-read from the ledger every five minutes, which is what
//     folds in the other shards' spend and corrects any drift.
//
// A guild whose totals have never been loaded is allowed through while the
// first load runs. That is a deliberate hole with a known size: one refresh
// interval of a cold start, after which local bumping keeps the figure current.
// The alternative is an async check on a synchronous path, which would mean a
// placeholder message on screen for a turn that was never allowed.
const MONTHLY_CACHE_TTL_MS = 5 * 60 * 1000;
const MONTHLY_CACHE_MAX = 5_000;

const monthlyCache = new Map();
const monthlyLoads = new Set();

/** The first day of the month after `month`, as the ledger's YYYY-MM-DD key. */
function monthAfter(month) {
    const [year, index] = month.split('-').map(Number);
    const next = new Date(Date.UTC(year, index, 1));
    return next.toISOString().slice(0, 10);
}

/**
 * The month's totals, straight from the ledger.
 *
 * Bounded at both ends. For the current month the upper bound changes nothing —
 * there are no rows dated after today — but `month` is a parameter, and an
 * open-ended `$gte` would answer a question about March with March plus
 * everything since. A total that quietly means something else than it says is
 * the wrong thing to hand a spend limit.
 */
async function loadMonthlyUsage(guildId, month = utcMonthString()) {
    const rows = await AIUsage.find({
        guildId,
        day: { $gte: `${month}-01`, $lt: monthAfter(month) }
    }).lean();

    let tokens = 0;
    let cost = 0;
    let costKnown = true;
    for (const row of rows) {
        tokens += (row.inputTokens || 0) + (row.outputTokens || 0);
        const rowCost = estimateCost(row.provider, row.model, row.inputTokens || 0, row.outputTokens || 0);
        if (rowCost == null) costKnown = false;
        else cost += rowCost;
    }
    return { month, tokens, cost, costKnown };
}

function cacheMonthly(guildId, totals) {
    // FIFO eviction, the same shape BoundedRateLimiter uses: a deployment with
    // more guilds than the ceiling loses the oldest entry, which costs that
    // guild one refresh rather than unbounded memory.
    if (!monthlyCache.has(guildId) && monthlyCache.size >= MONTHLY_CACHE_MAX) {
        monthlyCache.delete(monthlyCache.keys().next().value);
    }
    monthlyCache.set(guildId, { ...totals, at: Date.now() });
}

/**
 * Reload one guild's month in the background. Never awaited by the enforcement
 * path — a limit check must not become a database round trip — and never
 * duplicated: a second call while one is in flight is dropped.
 */
function refreshMonthlyUsage(guildId) {
    if (!guildId || monthlyLoads.has(guildId)) return;
    monthlyLoads.add(guildId);
    loadMonthlyUsage(guildId)
        .then(totals => cacheMonthly(guildId, totals))
        .catch(err => console.error('[AI usage] monthly refresh error:', err.message))
        .finally(() => monthlyLoads.delete(guildId));
}

/**
 * The month's totals as far as this process knows them, or null when they have
 * never been loaded (in which case a load is started).
 *
 * A stale entry is returned rather than withheld: local bumping has been
 * keeping it current, and refusing to answer would mean no ceiling at all for
 * the five minutes after each refresh falls due.
 */
function peekMonthlyUsage(guildId) {
    if (!guildId) return null;
    const entry = monthlyCache.get(guildId);
    const month = utcMonthString();

    // A month boundary invalidates the entry outright — last month's spend is
    // not this month's, and reading it as such would refuse a guild that has
    // just had its allowance renewed.
    if (!entry || entry.month !== month) {
        refreshMonthlyUsage(guildId);
        return null;
    }
    if (Date.now() - entry.at > MONTHLY_CACHE_TTL_MS) refreshMonthlyUsage(guildId);
    return { tokens: entry.tokens, cost: entry.cost, costKnown: entry.costKnown, month };
}

/** Add one call's spend to the cached total, if there is one to add it to. */
function bumpMonthlyUsage(guildId, tokens, cost) {
    const entry = monthlyCache.get(guildId);
    if (!entry || entry.month !== utcMonthString()) return;
    entry.tokens += tokens;
    if (cost == null) entry.costKnown = false;
    else entry.cost += cost;
}

/**
 * A guild's monthly allowance as a pair of used/limit/remaining blocks, or null
 * when it has no ceiling set.
 *
 * Shared between enforcement (which reads the cached total) and the dashboard
 * (which reads the ledger directly, so a panel somebody opened does not answer
 * "not loaded yet"). Two callers deriving the same numbers separately is two
 * places for them to disagree, and the one thing worse than a budget panel is a
 * budget panel that does not match what is refusing people.
 *
 * `complete` is false when some of the month's rows are on a model with no
 * pricing row, which makes the cost a floor rather than the total. A ceiling
 * enforced on a floor refuses late rather than early — the safe direction to be
 * wrong in for a limit that stops people talking to the bot.
 */
function monthlyBudget(totals, { monthlyTokens = 0, monthlyCost = 0 } = {}) {
    if (!totals || (monthlyTokens <= 0 && monthlyCost <= 0)) return null;

    return {
        tokens: monthlyTokens > 0
            ? {
                used: totals.tokens,
                limit: monthlyTokens,
                remaining: Math.max(0, monthlyTokens - totals.tokens)
            }
            : null,
        cost: monthlyCost > 0
            ? {
                used: round4(totals.cost),
                limit: monthlyCost,
                remaining: round4(Math.max(0, monthlyCost - totals.cost)),
                complete: totals.costKnown
            }
            : null
    };
}

/** Test seam: drop everything cached, so one test's guild is not another's. */
function resetMonthlyUsageCache() {
    monthlyCache.clear();
    monthlyLoads.clear();
}

async function recordUsage(guildId, provider, model, usage) {
    if (!guildId || !usage) return;
    const inputTokens = Math.max(0, Math.floor(usage.inputTokens || 0));
    const outputTokens = Math.max(0, Math.floor(usage.outputTokens || 0));
    if (inputTokens === 0 && outputTokens === 0) return;
    const day = utcDayString();
    const filter = { guildId, day, provider, model: model || 'unknown' };
    const update = {
        $inc: { inputTokens, outputTokens, requestCount: 1 },
        $set: { updatedAt: new Date() }
    };
    // Charged against the cached monthly total first, so the ceiling sees this
    // call even though the write below is what the next refresh will read. A
    // failed write leaves the cache a little pessimistic until that refresh,
    // which is the right way round for a spend limit.
    bumpMonthlyUsage(guildId, inputTokens + outputTokens, estimateCost(provider, model, inputTokens, outputTokens));

    try {
        await AIUsage.updateOne(filter, update, { upsert: true });
    } catch (err) {
        // Concurrent upserts on the same key can race: one succeeds, the other
        // throws E11000. Retry without upsert — the row exists now, so $inc
        // will hit it and we don't drop the token count.
        if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
            await AIUsage.updateOne(filter, update, { upsert: false });
        } else {
            throw err;
        }
    }
}

async function getUsageStats(guildId, days = 14) {
    const todayDay = utcDayString();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const startDay = utcDayString(start);

    const monthStart = todayDay.slice(0, 7) + '-01';
    const weekStart = (() => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 6);
        return utcDayString(d);
    })();

    // Fetch enough to cover both the sparkline window AND the current calendar
    // month so the "this month" KPI is accurate when `days` < day-of-month.
    const queryStart = monthStart < startDay ? monthStart : startDay;
    const rows = await AIUsage.find({ guildId, day: { $gte: queryStart } }).lean();

    // Aggregate per-day totals across providers/models for the sparkline window
    const byDay = new Map();
    for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - (days - 1 - i));
        const key = utcDayString(d);
        byDay.set(key, { day: key, inputTokens: 0, outputTokens: 0, requestCount: 0, cost: 0 });
    }

    let todayTokens = 0, weekTokens = 0, monthTokens = 0;
    let todayCost = 0, weekCost = 0, monthCost = 0;
    let costKnown = true;

    for (const row of rows) {
        const cost = estimateCost(row.provider, row.model, row.inputTokens, row.outputTokens);
        if (cost == null) costKnown = false;
        const totalTokens = row.inputTokens + row.outputTokens;

        const bucket = byDay.get(row.day);
        if (bucket) {
            bucket.inputTokens += row.inputTokens;
            bucket.outputTokens += row.outputTokens;
            bucket.requestCount += row.requestCount;
            bucket.cost += cost || 0;
        }

        if (row.day === todayDay) {
            todayTokens += totalTokens;
            todayCost += cost || 0;
        }
        if (row.day >= weekStart) {
            weekTokens += totalTokens;
            weekCost += cost || 0;
        }
        if (row.day >= monthStart) {
            monthTokens += totalTokens;
            monthCost += cost || 0;
        }
    }

    // Per-model breakdown for the current month
    const byModel = {};
    for (const row of rows.filter(r => r.day >= monthStart)) {
        const key = `${row.provider}/${row.model}`;
        if (!byModel[key]) {
            byModel[key] = {
                provider: row.provider, model: row.model,
                inputTokens: 0, outputTokens: 0, requestCount: 0, cost: 0, costKnown: true
            };
        }
        const m = byModel[key];
        m.inputTokens += row.inputTokens;
        m.outputTokens += row.outputTokens;
        m.requestCount += row.requestCount;
        const c = estimateCost(row.provider, row.model, row.inputTokens, row.outputTokens);
        if (c == null) m.costKnown = false;
        else m.cost += c;
    }

    return {
        today:  { tokens: todayTokens, cost: round4(todayCost) },
        week:   { tokens: weekTokens,  cost: round4(weekCost) },
        month:  { tokens: monthTokens, cost: round4(monthCost) },
        costKnown,
        daily: Array.from(byDay.values()).map(d => ({ ...d, cost: round4(d.cost) })),
        byModel: Object.values(byModel).map(m => ({ ...m, cost: round4(m.cost) }))
    };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = {
    estimateCost,
    recordUsage,
    getUsageStats,
    loadMonthlyUsage,
    monthlyBudget,
    refreshMonthlyUsage,
    peekMonthlyUsage,
    bumpMonthlyUsage,
    resetMonthlyUsageCache,
    utcMonthString,
    MONTHLY_CACHE_TTL_MS
};
