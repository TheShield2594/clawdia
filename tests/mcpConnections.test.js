'use strict';

// The connection pool three callers now share: the tool loop, the resource
// reader behind the knowledge prompt, and the prompt templates behind
// `/ai mcp prompt`. What matters here is that one caller's bad day is not
// another's — a refused resources/list must not close the session a tool call
// is in flight on — and that a session which really did expire still gets
// replaced.

const mockClose = jest.fn(async () => {});
const constructed = [];

jest.mock('../src/services/ai/mcp/client', () => {
    const actual = jest.requireActual('../src/services/ai/mcp/client');
    return {
        ...actual,
        McpHttpClient: class {
            constructor(options) {
                this.options = options;
                constructed.push(this);
                this.close = mockClose;
            }
        }
    };
});

const { McpError } = require('../src/services/ai/mcp/client');
const {
    entryFor,
    clientFor,
    withSession,
    withServerLimit,
    cachedList,
    primeList,
    resetMcpCache,
    LIST_TTL_MS,
    STALE_TTL_MS,
    MAX_PARALLEL_PER_SERVER
} = require('../src/services/ai/mcp/connections');

const SERVER = {
    name: 'docs',
    connection: { url: 'https://docs.example.com/mcp', authorizationToken: null }
};

// A promise somebody else settles, which is what a tool call in flight is.
function deferred() {
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    return { promise, ...settle };
}

beforeEach(() => {
    jest.clearAllMocks();
    constructed.length = 0;
    resetMcpCache();
});

describe('one failing list does not take the connection with it', () => {
    test('a refused resources/list leaves a tool call mid-flight alone', async () => {
        const entry = entryFor(SERVER);
        const call = deferred();

        // A tool call that has not come back yet, holding the client.
        const client = clientFor(entry, SERVER);
        const inFlight = withSession(entry, SERVER, c => {
            expect(c).toBe(client);
            return call.promise;
        });

        await expect(
            cachedList(entry, SERVER, 'resources', async () => { throw new Error('HTTP 500'); })
        ).rejects.toThrow('HTTP 500');

        // The session the call is using is still open, and still the same one.
        expect(mockClose).not.toHaveBeenCalled();
        expect(entry.client).toBe(client);

        call.resolve('tool output');
        await expect(inFlight).resolves.toBe('tool output');
        expect(mockClose).not.toHaveBeenCalled();
    });

    test('the other lists on that connection still work', async () => {
        const entry = entryFor(SERVER);

        await expect(
            cachedList(entry, SERVER, 'resources', async () => { throw new Error('HTTP 500'); })
        ).rejects.toThrow('HTTP 500');

        await expect(cachedList(entry, SERVER, 'tools', async () => [{ name: 'search' }]))
            .resolves.toEqual([{ name: 'search' }]);
        // One client for both, rather than a second one built over the failure.
        expect(constructed).toHaveLength(1);
    });

    test('but a session that really expired is replaced', async () => {
        const entry = entryFor(SERVER);
        const first = clientFor(entry, SERVER);

        await expect(cachedList(entry, SERVER, 'tools', async () => {
            throw new McpError('HTTP 404 — no MCP endpoint at this URL', { status: 404, sessionExpired: true });
        })).rejects.toThrow(/404/);

        // withSession retries once on its own; when the retry fails the same
        // way, the client is dropped so the next caller dials afresh.
        expect(mockClose).toHaveBeenCalled();
        expect(entry.client).toBeNull();
        expect(clientFor(entry, SERVER)).not.toBe(first);
    });
});

describe('caching', () => {
    test('a second caller mid-flight waits for the first rather than dialling again', async () => {
        const entry = entryFor(SERVER);
        const list = jest.fn(async () => [{ name: 'search' }]);

        const [a, b] = await Promise.all([
            cachedList(entry, SERVER, 'tools', list),
            cachedList(entry, SERVER, 'tools', list)
        ]);

        expect(a).toBe(b);
        expect(list).toHaveBeenCalledTimes(1);
    });

    test('a failure is remembered, so a server that is down is not dialled every message', async () => {
        const entry = entryFor(SERVER);
        const list = jest.fn(async () => { throw new Error('connect ETIMEDOUT'); });

        await expect(cachedList(entry, SERVER, 'prompts', list)).rejects.toThrow('connect ETIMEDOUT');
        await expect(cachedList(entry, SERVER, 'prompts', list)).rejects.toThrow('connect ETIMEDOUT');
        expect(list).toHaveBeenCalledTimes(1);
    });

    test('a list somebody else fetched can be handed straight to the pool', async () => {
        // The dashboard's Test button is a full discovery run whose answer was
        // being thrown away.
        const entry = entryFor(SERVER);
        const list = jest.fn();

        primeList(entry, 'tools', [{ name: 'search' }]);

        await expect(cachedList(entry, SERVER, 'tools', list)).resolves.toEqual([{ name: 'search' }]);
        expect(list).not.toHaveBeenCalled();
    });
});

describe('an expired list is refreshed behind whoever asked for it', () => {
    // Expiry is not "this list is wrong", it is "go and check". The message
    // that happens to arrive five minutes and one second after the last one
    // should not be the one that pays for the round trip.
    const past = ms => jest.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('the caller that finds it expired gets the old list, and the new one lands behind', async () => {
        const entry = entryFor(SERVER);
        const list = jest.fn()
            .mockResolvedValueOnce([{ name: 'old' }])
            .mockResolvedValueOnce([{ name: 'new' }]);

        await cachedList(entry, SERVER, 'tools', list);
        past(LIST_TTL_MS + 1000);

        // Served without waiting, even though the refresh has not answered.
        await expect(cachedList(entry, SERVER, 'tools', list)).resolves.toEqual([{ name: 'old' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(list).toHaveBeenCalledTimes(2);
        await expect(cachedList(entry, SERVER, 'tools', list)).resolves.toEqual([{ name: 'new' }]);
    });

    test('a refresh that fails leaves the old list in place rather than nothing', async () => {
        const entry = entryFor(SERVER);
        const list = jest.fn()
            .mockResolvedValueOnce([{ name: 'search' }])
            .mockRejectedValue(new Error('connect ETIMEDOUT'));

        await cachedList(entry, SERVER, 'tools', list);
        past(LIST_TTL_MS + 1000);

        await expect(cachedList(entry, SERVER, 'tools', list)).resolves.toEqual([{ name: 'search' }]);
        await Promise.resolve();
        await Promise.resolve();
        // Still the old list, and the failed refresh is not retried on every
        // message either — the failure window applies the same as ever.
        await expect(cachedList(entry, SERVER, 'tools', list)).resolves.toEqual([{ name: 'search' }]);
        expect(list).toHaveBeenCalledTimes(2);
    });

    test('past the stale window the caller waits for a fresh list', async () => {
        const entry = entryFor(SERVER);
        const list = jest.fn()
            .mockResolvedValueOnce([{ name: 'old' }])
            .mockResolvedValueOnce([{ name: 'new' }]);

        await cachedList(entry, SERVER, 'tools', list);
        past(LIST_TTL_MS + STALE_TTL_MS + 1000);

        await expect(cachedList(entry, SERVER, 'tools', list)).resolves.toEqual([{ name: 'new' }]);
    });
});

describe('one server does not see the whole round at once', () => {
    test(`at most ${MAX_PARALLEL_PER_SERVER} requests are in flight against one connection`, async () => {
        const entry = entryFor(SERVER);
        let running = 0;
        let peak = 0;
        const gates = [];

        const calls = Array.from({ length: 6 }, () => withServerLimit(entry, () => {
            running++;
            peak = Math.max(peak, running);
            const gate = deferred();
            gates.push(gate);
            return gate.promise.then(value => { running--; return value; });
        }));

        // Nothing past the cap has started, however many were asked for.
        await Promise.resolve();
        expect(peak).toBe(MAX_PARALLEL_PER_SERVER);

        // Each one that finishes hands its slot to the next, which starts and
        // takes a gate of its own — so they are released one at a time.
        while (gates.length) {
            gates.shift().resolve('ok');
            await new Promise(resolve => setImmediate(resolve));
        }
        await expect(Promise.all(calls)).resolves.toEqual(Array(6).fill('ok'));
        expect(peak).toBe(MAX_PARALLEL_PER_SERVER);
    });

    test('a call that throws still releases its slot', async () => {
        const entry = entryFor(SERVER);

        await expect(withServerLimit(entry, async () => { throw new Error('HTTP 500'); }))
            .rejects.toThrow('HTTP 500');

        expect(entry.inFlight).toBe(0);
        await expect(withServerLimit(entry, async () => 'ok')).resolves.toBe('ok');
    });
});
