'use strict';

// The AIUsage ledger has always been record-only: every AI call wrote a row and
// nothing ever read one back as a limit. Per-user and per-channel windows bound
// one person's chatter; nothing bounded what a *server* could spend in total,
// and the scheduled runs — unattributed by design — were outside both. These
// tests hold the ceiling at the same dispatch-layer chokepoint (#831).

jest.mock('../src/models/AIUsage', () => ({ find: jest.fn(), updateOne: jest.fn(async () => {}) }));

jest.mock('../src/services/ai/providers', () => {
    const complete = jest.fn(async () => ({ text: 'ok', usage: null }));
    const stream = jest.fn(async function* () { yield 'ok'; });
    const provider = {
        name: 'mock', label: 'Mock', defaultModel: 'mock-1',
        resolveAuth: () => ({ apiKey: 'k' }),
        // A pricing table, so cost estimation has something to work from.
        pricing: [{ match: /^mock-1$/, in: 1000, out: 2000 }],
        complete, stream,
    };
    return {
        providers: new Map([['mock', provider]]),
        getProvider: () => provider,
        DEFAULT_MODELS: { mock: 'mock-1' },
        __complete: complete,
        __stream: stream,
    };
});

const AIUsage = require('../src/models/AIUsage');
const providersMock = require('../src/services/ai/providers');
const usage = require('../src/services/ai/usage');
const { monthlyBudgetState, AiBudgetError } = require('../src/services/ai/rateLimit');
const { resolveProviderConfig, getCompletion, streamCompletion } = require('../src/services/ai');

const BASE = { provider: 'mock', model: 'mock-1' };

let seq = 0;
const nextGuild = () => `budget-guild-${++seq}`;

/** What the ledger will answer with for the current month. */
function ledger(rows) {
    AIUsage.find.mockReturnValue({ lean: async () => rows });
}

/** One row in the month, in the shape the ledger stores. */
function row(inputTokens, outputTokens, model = 'mock-1') {
    return { provider: 'mock', model, day: `${usage.utcMonthString()}-01`, inputTokens, outputTokens, requestCount: 1 };
}

/**
 * Prime the cache the synchronous check reads, the way a running process does:
 * the first request through a guild starts a load, and the load lands before
 * the next one arrives.
 */
async function prime(guildId) {
    usage.refreshMonthlyUsage(guildId);
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    usage.resetMonthlyUsageCache();
    AIUsage.find.mockReset();
    AIUsage.updateOne.mockClear();
    providersMock.__complete.mockClear();
    providersMock.__stream.mockClear();
    ledger([]);
});

describe('reading the ledger as a limit', () => {
    it('reports nothing for a guild with no ceiling set', async () => {
        const guildId = nextGuild();
        ledger([row(1_000_000, 1_000_000)]);
        await prime(guildId);

        expect(monthlyBudgetState(guildId, { monthlyTokens: 0, monthlyCost: 0 })).toBeNull();
    });

    it('totals the month and says what is left', async () => {
        const guildId = nextGuild();
        ledger([row(300, 200), row(100, 400)]);
        await prime(guildId);

        expect(monthlyBudgetState(guildId, { monthlyTokens: 5000 }).tokens)
            .toEqual({ used: 1000, limit: 5000, remaining: 4000 });
    });

    it('marks the cost figure incomplete when a model has no pricing row', async () => {
        const guildId = nextGuild();
        ledger([row(1000, 1000), row(1000, 1000, 'some-unpriced-model')]);
        await prime(guildId);

        const state = monthlyBudgetState(guildId, { monthlyCost: 100 });
        expect(state.cost.complete).toBe(false);
        // Only the priced row counted, so the total is a floor — which refuses
        // late rather than early, the safe direction for a spend limit.
        expect(state.cost.used).toBeCloseTo((1000 * 1000 + 1000 * 2000) / 1e6, 10);
    });

    it('answers nothing at all until the month has been loaded once', () => {
        // A cold cache allows the request through and starts the load, rather
        // than turning a synchronous check into a database round trip.
        expect(monthlyBudgetState(nextGuild(), { monthlyTokens: 1 })).toBeNull();
    });

    it('does not read last month\'s total as this month\'s', async () => {
        const guildId = nextGuild();
        ledger([row(9_000, 1_000)]);
        await prime(guildId);
        expect(monthlyBudgetState(guildId, { monthlyTokens: 10_000 }).tokens.used).toBe(10_000);

        // Roll the clock into next month. The cached entry is stamped with the
        // month it was loaded for, so it is dropped rather than enforced on —
        // a guild whose allowance has just renewed must not be refused on last
        // month's total. The ledger answers empty for the new month, and the
        // reload it kicks off is not awaited, so the answer is "not known yet".
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
            const nextMonth = new Date(`${usage.utcMonthString()}-01T00:00:00Z`);
            nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
            jest.setSystemTime(nextMonth);

            expect(monthlyBudgetState(guildId, { monthlyTokens: 10_000 })).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('enforcement at the dispatch layer', () => {
    it('refuses once the month\'s tokens are spent, without calling the provider', async () => {
        const guildId = nextGuild();
        ledger([row(6_000, 4_000)]);
        await prime(guildId);

        const config = resolveProviderConfig({ ...BASE, monthlyTokenLimit: 10_000 });
        await expect(getCompletion({ ...config, guildId, userId: 'u1', prompt: 'hi' }))
            .rejects.toBeInstanceOf(AiBudgetError);
        expect(providersMock.__complete).not.toHaveBeenCalled();
    });

    it('refuses on the cost ceiling too', async () => {
        const guildId = nextGuild();
        // 1M in + 1M out on the mock pricing table is $1000 + $2000.
        ledger([row(1_000_000, 1_000_000)]);
        await prime(guildId);

        const config = resolveProviderConfig({ ...BASE, monthlyCostLimit: 50 });
        await expect(getCompletion({ ...config, guildId, userId: 'u1', prompt: 'hi' }))
            .rejects.toMatchObject({ rateLimited: true, scope: 'guild', exceeded: 'cost' });
    });

    it('lets a guild inside its budget through', async () => {
        const guildId = nextGuild();
        ledger([row(10, 10)]);
        await prime(guildId);

        const config = resolveProviderConfig({ ...BASE, monthlyTokenLimit: 10_000 });
        await getCompletion({ ...config, guildId, userId: 'u1', prompt: 'hi' });
        expect(providersMock.__complete).toHaveBeenCalledTimes(1);
    });

    it('binds the scheduled runs, which no other limit here reaches', async () => {
        // The digests and newspapers name no user and no channel, so both
        // sliding windows skip them. They spend the same guild's money.
        const guildId = nextGuild();
        ledger([row(20_000, 0)]);
        await prime(guildId);

        const config = resolveProviderConfig({ ...BASE, monthlyTokenLimit: 10_000 });
        await expect(getCompletion({ ...config, guildId, prompt: 'digest' }))
            .rejects.toMatchObject({ scope: 'guild' });
        expect(providersMock.__complete).not.toHaveBeenCalled();
    });

    it('refuses the stream on the call, not on the first chunk', async () => {
        const guildId = nextGuild();
        ledger([row(20_000, 0)]);
        await prime(guildId);

        const config = resolveProviderConfig({ ...BASE, monthlyTokenLimit: 10_000 });
        expect(() => streamCompletion({ ...config, guildId, userId: 'u1', prompt: 'hi' }))
            .toThrow(AiBudgetError);
        expect(providersMock.__stream).not.toHaveBeenCalled();
    });

    it('does not spend a per-user slot on a guild that is out of budget', async () => {
        const guildId = nextGuild();
        ledger([row(20_000, 0)]);
        await prime(guildId);

        const capped = resolveProviderConfig({ ...BASE, monthlyTokenLimit: 10_000, rateLimitPerUser: 1 });
        await expect(getCompletion({ ...capped, guildId, userId: 'u2', prompt: 'hi' }))
            .rejects.toMatchObject({ scope: 'guild' });

        // The guild is out of money either way, but the person should not also
        // have lost their own allowance to the refusal — so once the ceiling is
        // lifted, their full allowance is still there.
        const open = resolveProviderConfig({ ...BASE, rateLimitPerUser: 1 });
        await getCompletion({ ...open, guildId, userId: 'u2', prompt: 'hi' });
        expect(providersMock.__complete).toHaveBeenCalledTimes(1);
    });

    it('leaves a guild with no ceiling exactly as it was', async () => {
        const guildId = nextGuild();
        ledger([row(50_000_000, 50_000_000)]);
        await prime(guildId);

        const config = resolveProviderConfig(BASE);
        for (let i = 0; i < 3; i++) await getCompletion({ ...config, guildId, userId: 'u1', prompt: 'hi' });
        expect(providersMock.__complete).toHaveBeenCalledTimes(3);
    });
});

describe('keeping the cached total honest between refreshes', () => {
    it('charges each recorded call against the cached month straight away', async () => {
        const guildId = nextGuild();
        ledger([row(0, 0)]);
        await prime(guildId);

        await usage.recordUsage(guildId, 'mock', 'mock-1', { inputTokens: 4000, outputTokens: 1000 });
        expect(monthlyBudgetState(guildId, { monthlyTokens: 10_000 }).tokens.used).toBe(5000);

        // Which is what makes the next call refusable without waiting five
        // minutes for the ledger to be re-read.
        await usage.recordUsage(guildId, 'mock', 'mock-1', { inputTokens: 5000, outputTokens: 0 });
        const config = resolveProviderConfig({ ...BASE, monthlyTokenLimit: 10_000 });
        await expect(getCompletion({ ...config, guildId, userId: 'u1', prompt: 'hi' }))
            .rejects.toMatchObject({ scope: 'guild' });
    });

    it('ignores a call for a guild it is not tracking', async () => {
        // No cached entry to bump, and no load kicked off by a write: the cache
        // is populated by the read path, not by every guild that ever spent.
        await expect(usage.recordUsage(nextGuild(), 'mock', 'mock-1', { inputTokens: 1, outputTokens: 1 }))
            .resolves.toBeUndefined();
    });
});
