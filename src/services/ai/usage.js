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

module.exports = { estimateCost, recordUsage, getUsageStats };
