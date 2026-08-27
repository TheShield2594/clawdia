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
    cachedList,
    resetMcpCache
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
});
