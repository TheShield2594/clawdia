'use strict';

// The per-guild MCP ledger, which is what the Connections panel reads to answer
// the question the Test button cannot: has this connection been working when
// nobody was looking at it.
//
// The rollup is the whole design — a per-call log would be thousands of writes
// a day for a question only ever asked in aggregate — so what these cover is
// the arithmetic of folding a turn into rows, and the one distinction the panel
// depends on: a call nobody approved is not a call that failed.

const mockUpdateOne = jest.fn(async () => ({}));
const mockFind = jest.fn(() => ({ lean: async () => [] }));

jest.mock('../src/models/McpUsage', () => ({
    updateOne: (...args) => mockUpdateOne(...args),
    find: (...args) => mockFind(...args)
}));

const { summarise, recordToolCalls, getToolUsage, CONNECTION_ROW } = require('../src/services/ai/mcp/usage');

const call = (tool, extra = {}) => ({ server: 'github', tool, ok: true, durationMs: 1000, ...extra });

beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({});
    mockFind.mockReturnValue({ lean: async () => [] });
});

describe('folding a turn into rows', () => {
    test('sums repeat calls to one tool instead of writing each of them', () => {
        expect(summarise([call('search'), call('search'), call('read')])).toEqual([
            { server: 'github', tool: 'search', calls: 2, failures: 0, declined: 0, totalMs: 2000, lastError: null },
            { server: 'github', tool: 'read', calls: 1, failures: 0, declined: 0, totalMs: 1000, lastError: null }
        ]);
    });

    test('keeps servers apart even when the tool names match', () => {
        const rows = summarise([call('search'), { ...call('search'), server: 'deepwiki' }]);
        expect(rows.map(r => r.server)).toEqual(['github', 'deepwiki']);
    });

    test('counts a failure and remembers what the server said', () => {
        const [row] = summarise([call('search', { ok: false, error: 'HTTP 502' })]);
        expect(row).toMatchObject({ calls: 1, failures: 1, declined: 0, lastError: 'HTTP 502' });
    });

    test('counts a refusal as declined, not as a failure', () => {
        // The connection worked and the answer was no. Filing that as a failure
        // would make a guild that uses approvals look permanently broken.
        const [row] = summarise([call('create_issue', { ok: false, declined: true })]);
        expect(row).toMatchObject({ calls: 1, failures: 0, declined: 1 });
    });

    test('gives a server nobody could reach a row of its own', () => {
        // It made no calls, so without this it is indistinguishable from a
        // connection nobody used.
        expect(summarise([], ['github'])).toEqual([
            { server: 'github', tool: CONNECTION_ROW, calls: 1, failures: 1, declined: 0, totalMs: 0, lastError: null }
        ]);
    });

    test('ignores a call with nothing usable to file it under', () => {
        expect(summarise([{ ok: true }, { server: 'github' }, null])).toEqual([]);
    });

    test('ignores a duration that is missing or nonsense', () => {
        const [row] = summarise([call('search', { durationMs: undefined }), call('search', { durationMs: -5 })]);
        expect(row).toMatchObject({ calls: 2, totalMs: 0 });
    });

    test('caps a name the far side made absurdly long', () => {
        const [row] = summarise([call('t'.repeat(500))]);
        expect(row.tool.length).toBe(128);
    });
});

describe('writing them', () => {
    test('writes one row per tool, keyed by guild and day', async () => {
        await recordToolCalls('g1', [call('search'), call('search')]);

        expect(mockUpdateOne).toHaveBeenCalledTimes(1);
        const [filter, update, options] = mockUpdateOne.mock.calls[0];
        expect(filter).toMatchObject({ guildId: 'g1', server: 'github', tool: 'search' });
        expect(filter.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(update.$inc).toEqual({ calls: 2, failures: 0, declined: 0, totalMs: 2000 });
        expect(options).toEqual({ upsert: true });
    });

    test('retries without upsert when two turns race the same row', async () => {
        // Both finish together, one creates the row and the other gets E11000.
        // The row exists by then, so the retry lands the counts.
        const duplicate = Object.assign(new Error('dup'), { code: 11000 });
        mockUpdateOne.mockRejectedValueOnce(duplicate);

        await recordToolCalls('g1', [call('search')]);

        expect(mockUpdateOne).toHaveBeenCalledTimes(2);
        expect(mockUpdateOne.mock.calls[1][2]).toEqual({ upsert: false });
    });

    test('never throws at the caller — the reply has already been sent', async () => {
        mockUpdateOne.mockRejectedValue(new Error('mongo is gone'));
        await expect(recordToolCalls('g1', [call('search')])).resolves.toBeUndefined();
    });

    test('writes nothing for a turn that used no tools', async () => {
        await recordToolCalls('g1', []);
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    test('writes nothing when there is no guild to file it under', async () => {
        await recordToolCalls(null, [call('search')]);
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });
});

describe('reading them back', () => {
    const row = (over = {}) => ({
        guildId: 'g1', server: 'github', tool: 'search', day: '2026-08-25',
        calls: 0, failures: 0, declined: 0, totalMs: 0, lastError: null, lastErrorAt: null,
        ...over
    });

    test('rolls the days up per server and per tool', async () => {
        mockFind.mockReturnValue({ lean: async () => [
            row({ tool: 'search', calls: 3, totalMs: 3000, day: '2026-08-24' }),
            row({ tool: 'search', calls: 1, totalMs: 500 }),
            row({ tool: 'create_issue', calls: 2, declined: 1, totalMs: 4000 })
        ] });

        const [server] = await getToolUsage('g1');

        expect(server).toMatchObject({ server: 'github', calls: 6, declined: 1, avgMs: 1250 });
        expect(server.tools.map(t => t.tool)).toEqual(['search', 'create_issue']);
        expect(server.tools[0]).toMatchObject({ calls: 4, avgMs: 875 });
    });

    test('reports an unreachable connection separately from its calls', async () => {
        mockFind.mockReturnValue({ lean: async () => [
            row({ tool: 'search', calls: 2, totalMs: 2000 }),
            row({ tool: CONNECTION_ROW, calls: 5, failures: 5 })
        ] });

        const [server] = await getToolUsage('g1');

        // The connection failures are not calls, so they must not dilute the
        // per-call average or show up as a tool nobody has heard of.
        expect(server).toMatchObject({ calls: 2, unreachable: 5, avgMs: 1000 });
        expect(server.tools.map(t => t.tool)).toEqual(['search']);
    });

    test('keeps the most recent failure, not the first one', async () => {
        mockFind.mockReturnValue({ lean: async () => [
            row({ failures: 1, lastError: 'HTTP 500', lastErrorAt: new Date('2026-08-20') }),
            row({ tool: 'read', failures: 1, lastError: 'HTTP 502', lastErrorAt: new Date('2026-08-24') })
        ] });

        expect((await getToolUsage('g1'))[0].lastError).toBe('HTTP 502');
    });

    test('puts the busiest server first', async () => {
        mockFind.mockReturnValue({ lean: async () => [
            row({ server: 'quiet', calls: 1 }),
            row({ server: 'busy', calls: 40 })
        ] });

        expect((await getToolUsage('g1')).map(s => s.server)).toEqual(['busy', 'quiet']);
    });

    test('asks only for days inside the window', async () => {
        await getToolUsage('g1', 7);
        const [query] = mockFind.mock.calls[0];
        expect(query.guildId).toBe('g1');
        expect(query.day.$gte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('answers an empty list rather than nothing at all', async () => {
        expect(await getToolUsage('g1')).toEqual([]);
    });
});
