'use strict';

// #1046: the cached-token counts the providers already hand back are recorded
// into the AIUsage ledger alongside the input/output totals, so the dashboard
// can show a prompt-cache hit rate. These cover the write (recordUsage) and the
// read (getUsageStats) ends of that field.

jest.mock('../src/models/AIUsage', () => ({ find: jest.fn(), updateOne: jest.fn(async () => {}) }));

jest.mock('../src/services/ai/providers', () => {
    const provider = { name: 'mock', label: 'Mock', pricing: [{ match: /^mock-1$/, in: 1000, out: 2000 }] };
    return { providers: new Map([['mock', provider]]), getProvider: () => provider };
});

const AIUsage = require('../src/models/AIUsage');
const usage = require('../src/services/ai/usage');

const day = `${usage.utcMonthString()}-01`;
const row = fields => ({ provider: 'mock', model: 'mock-1', day, requestCount: 1, ...fields });

beforeEach(() => {
    AIUsage.find.mockReset();
    AIUsage.updateOne.mockClear();
});

describe('recording the cached share of the input', () => {
    test('adds cachedInputTokens to the row it increments', async () => {
        await usage.recordUsage('g1', 'openai', 'gpt-4o', { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 });

        const [, update] = AIUsage.updateOne.mock.calls[0];
        expect(update.$inc).toMatchObject({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 });
    });

    test('defaults to zero for a provider that reports none', async () => {
        await usage.recordUsage('g1', 'ollama', 'llama3', { inputTokens: 500, outputTokens: 100 });

        expect(AIUsage.updateOne.mock.calls[0][1].$inc.cachedInputTokens).toBe(0);
    });

    // A provider that double-counted must not make the panel read over 100%.
    test('never records more cached than the input it is part of', async () => {
        await usage.recordUsage('g1', 'openai', 'gpt-4o', { inputTokens: 300, outputTokens: 10, cachedInputTokens: 999 });

        expect(AIUsage.updateOne.mock.calls[0][1].$inc.cachedInputTokens).toBe(300);
    });
});

describe('surfacing the hit rate in the stats', () => {
    test('reports the month cached total and the input it is measured against', async () => {
        AIUsage.find.mockReturnValue({ lean: async () => [
            row({ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 600 }),
            row({ inputTokens: 500, outputTokens: 100, cachedInputTokens: 100 }),
        ] });

        const stats = await usage.getUsageStats('g1', 14);

        // 700 of 1500 input tokens came from cache this month.
        expect(stats.cache).toEqual({ inputTokens: 1500, cachedInputTokens: 700 });
    });

    test('carries the cached count into the per-model breakdown', async () => {
        AIUsage.find.mockReturnValue({ lean: async () => [
            row({ inputTokens: 800, outputTokens: 50, cachedInputTokens: 320 }),
        ] });

        const stats = await usage.getUsageStats('g1', 14);

        expect(stats.byModel[0]).toMatchObject({
            provider: 'mock', model: 'mock-1', inputTokens: 800, cachedInputTokens: 320,
        });
    });

    test('an idle month reports zero cache, not a division by nothing', async () => {
        AIUsage.find.mockReturnValue({ lean: async () => [] });

        const stats = await usage.getUsageStats('g1', 14);

        expect(stats.cache).toEqual({ inputTokens: 0, cachedInputTokens: 0 });
    });
});
