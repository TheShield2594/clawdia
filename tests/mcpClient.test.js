'use strict';

// The Streamable HTTP MCP client. Anthropic used to open these connections, so
// none of this existed; now the bot is the client for every other provider and
// the transport details are load-bearing — the session header, the initialized
// notification, and the fact that a server may answer a POST with an SSE stream
// rather than a JSON body.

jest.mock('axios');

const { Readable } = require('stream');
const axios = require('axios');
const { McpHttpClient, McpError } = require('../src/services/ai/mcp/client');

const URL = 'https://mcp.example.com/mcp';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        status,
        headers: { 'content-type': 'application/json', ...headers },
        data: Readable.from([JSON.stringify(body)])
    };
}

function sseResponse(events, { status = 200, headers = {} } = {}) {
    const text = events.map(event => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return {
        status,
        headers: { 'content-type': 'text/event-stream', ...headers },
        data: Readable.from([text])
    };
}

function textResponse(body, status) {
    return { status, headers: { 'content-type': 'text/plain' }, data: Readable.from([body]) };
}

// 202 with no body: what a server returns for a notification.
function acceptedResponse() {
    return { status: 202, headers: {}, data: Readable.from([]) };
}

const INIT_RESULT = {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'Example MCP', version: '1.2.3' }
};

// Answers each POST by method, so a test only has to describe the calls it
// cares about and the handshake stays out of the way.
function respondBy(handlers) {
    axios.post.mockImplementation(async (_url, payload) => {
        if (!(payload.method in handlers)) throw new Error(`unexpected method ${payload.method}`);
        const handler = handlers[payload.method];
        // A null handler is a notification: 202, no body.
        const body = typeof handler === 'function' ? handler(payload) : handler;
        if (body === null) return acceptedResponse();
        return jsonResponse({ jsonrpc: '2.0', id: payload.id, ...body });
    });
}

const HANDSHAKE = {
    initialize: { result: INIT_RESULT },
    'notifications/initialized': null
};

function postsTo(method) {
    return axios.post.mock.calls.filter(call => call[1].method === method);
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('handshake', () => {
    test('initializes, adopts the session id, then confirms with a notification', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'initialize') {
                return jsonResponse(
                    { jsonrpc: '2.0', id: payload.id, result: INIT_RESULT },
                    { headers: { 'mcp-session-id': 'sess-42' } }
                );
            }
            return acceptedResponse();
        });

        const client = new McpHttpClient({ url: URL });
        await client.initialize();

        expect(postsTo('initialize')).toHaveLength(1);
        // The confirmation is a notification: no id, so nothing is waited for.
        const [, notification] = postsTo('notifications/initialized')[0];
        expect(notification.id).toBeUndefined();
        expect(client.serverInfo).toEqual(INIT_RESULT.serverInfo);

        // Session and negotiated version ride on every later request.
        const headers = postsTo('notifications/initialized')[0][2].headers;
        expect(headers['Mcp-Session-Id']).toBe('sess-42');
        expect(headers['MCP-Protocol-Version']).toBe('2025-06-18');
    });

    test('does not repeat the handshake for later calls', async () => {
        respondBy({ ...HANDSHAKE, 'tools/list': { result: { tools: [] } } });

        const client = new McpHttpClient({ url: URL });
        await client.listTools();
        await client.listTools();

        expect(postsTo('initialize')).toHaveLength(1);
        expect(postsTo('tools/list')).toHaveLength(2);
    });

    test('accepts both shapes of Accept, and asks for both response types', async () => {
        respondBy(HANDSHAKE);
        await new McpHttpClient({ url: URL }).initialize();
        expect(postsTo('initialize')[0][2].headers.Accept).toBe('application/json, text/event-stream');
    });
});

describe('authorization', () => {
    test('sends a bare token as a bearer token', async () => {
        respondBy(HANDSHAKE);
        await new McpHttpClient({ url: URL, authorizationToken: 'ghp_abc' }).initialize();
        expect(postsTo('initialize')[0][2].headers.Authorization).toBe('Bearer ghp_abc');
    });

    test('leaves a token that already names its scheme alone', async () => {
        respondBy(HANDSHAKE);
        await new McpHttpClient({ url: URL, authorizationToken: 'Bearer ghp_abc' }).initialize();
        expect(postsTo('initialize')[0][2].headers.Authorization).toBe('Bearer ghp_abc');
    });

    test('sends no header at all when there is no token', async () => {
        respondBy(HANDSHAKE);
        await new McpHttpClient({ url: URL }).initialize();
        expect(postsTo('initialize')[0][2].headers.Authorization).toBeUndefined();
    });
});

describe('SSRF guard', () => {
    // The URL is a dashboard field, so this is the check that stops a guild
    // admin pointing the bot at the metadata service or the Mongo host.
    test.each([
        ['the metadata service', 'http://169.254.169.254/mcp'],
        ['loopback', 'http://127.0.0.1:8080/mcp'],
        ['private space', 'https://10.1.2.3/mcp']
    ])('refuses a literal address in %s', (_label, url) => {
        expect(() => new McpHttpClient({ url })).toThrow(/private or reserved/);
    });

    test('refuses a scheme that is not http(s)', () => {
        expect(() => new McpHttpClient({ url: 'file:///etc/passwd' })).toThrow();
    });

    test('dials through the guarded agents, which check the address at connect time', async () => {
        respondBy(HANDSHAKE);
        await new McpHttpClient({ url: URL }).initialize();
        const options = postsTo('initialize')[0][2];
        expect(options.httpsAgent).toBeDefined();
        expect(options.httpAgent).toBeDefined();
    });
});

describe('server-sent event responses', () => {
    test('reads the answer out of an SSE stream', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') {
                return sseResponse([{ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }]);
            }
            return sseResponse([
                // Progress notifications share the stream and are not the answer.
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
                { jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'search' }] } }
            ]);
        });

        const tools = await new McpHttpClient({ url: URL }).listTools();
        expect(tools).toEqual([{ name: 'search' }]);
    });

    test('reports a stream that ends without answering', async () => {
        axios.post.mockImplementation(async (_url, payload) =>
            payload.method === 'notifications/initialized' ? acceptedResponse() : sseResponse([]));

        await expect(new McpHttpClient({ url: URL }).initialize())
            .rejects.toThrow(/closed the stream/);
    });
});

describe('tools/list', () => {
    test('follows the cursor to the end', async () => {
        respondBy({
            ...HANDSHAKE,
            'tools/list': payload => (payload.params.cursor
                ? { result: { tools: [{ name: 'b' }] } }
                : { result: { tools: [{ name: 'a' }], nextCursor: 'page-2' } })
        });

        const tools = await new McpHttpClient({ url: URL }).listTools();
        expect(tools.map(t => t.name)).toEqual(['a', 'b']);
    });

    test('drops entries without a usable name rather than offering them', async () => {
        respondBy({
            ...HANDSHAKE,
            'tools/list': { result: { tools: [{ name: 'ok' }, { description: 'nameless' }, null] } }
        });

        expect(await new McpHttpClient({ url: URL }).listTools()).toEqual([{ name: 'ok' }]);
    });
});

describe('tools/call', () => {
    test('sends the name and arguments and returns the content', async () => {
        respondBy({
            ...HANDSHAKE,
            'tools/call': { result: { content: [{ type: 'text', text: 'four' }] } }
        });

        const client = new McpHttpClient({ url: URL });
        const result = await client.callTool('add', { a: 2, b: 2 });

        expect(postsTo('tools/call')[0][1].params).toEqual({ name: 'add', arguments: { a: 2, b: 2 } });
        expect(result).toEqual({
            content: [{ type: 'text', text: 'four' }],
            structuredContent: null,
            isError: false
        });
    });

    test('passes a tool-level error back rather than throwing it', async () => {
        // "That repository does not exist" is an answer the model should read,
        // not a reason to abandon the reply.
        respondBy({
            ...HANDSHAKE,
            'tools/call': { result: { content: [{ type: 'text', text: 'no such repo' }], isError: true } }
        });

        const result = await new McpHttpClient({ url: URL }).callTool('get_repo', {});
        expect(result.isError).toBe(true);
    });

    test('substitutes an empty object for arguments that are not an object', async () => {
        respondBy({ ...HANDSHAKE, 'tools/call': { result: { content: [] } } });
        await new McpHttpClient({ url: URL }).callTool('ping', undefined);
        expect(postsTo('tools/call')[0][1].params.arguments).toEqual({});
    });
});

describe('failures', () => {
    test('turns a JSON-RPC error into a readable message', async () => {
        respondBy({
            ...HANDSHAKE,
            'tools/list': { error: { code: -32601, message: 'Method not found' } }
        });

        await expect(new McpHttpClient({ url: URL }).listTools()).rejects.toThrow('Method not found');
    });

    test.each([
        [401, /authorization token/],
        [403, /authorization token/],
        [404, /no MCP endpoint/],
        [500, /HTTP 500/]
    ])('explains an HTTP %s', async (status, expected) => {
        axios.post.mockResolvedValue(textResponse('upstream said no', status));
        await expect(new McpHttpClient({ url: URL }).initialize()).rejects.toThrow(expected);
    });

    test('marks a 404 as an expired session so the caller can reconnect', async () => {
        axios.post.mockResolvedValue(textResponse('unknown session', 404));
        await expect(new McpHttpClient({ url: URL }).initialize())
            .rejects.toMatchObject({ sessionExpired: true });
    });

    test('reports a transport failure as an McpError, not a raw axios throw', async () => {
        axios.post.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
        const error = await new McpHttpClient({ url: URL }).initialize().catch(e => e);
        expect(error).toBeInstanceOf(McpError);
        expect(error.code).toBe('ENOTFOUND');
    });

    test('rejects a response body that is not JSON at all', async () => {
        axios.post.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: Readable.from(['<html>login</html>'])
        });
        await expect(new McpHttpClient({ url: URL }).initialize()).rejects.toThrow(/non-JSON/);
    });
});

describe('close', () => {
    test('deletes the session it was given', async () => {
        axios.post.mockImplementation(async (_url, payload) => (
            payload.method === 'initialize'
                ? jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }, { headers: { 'mcp-session-id': 'sess-9' } })
                : acceptedResponse()
        ));
        axios.delete.mockResolvedValue({ status: 204, headers: {} });

        const client = new McpHttpClient({ url: URL });
        await client.initialize();
        await client.close();

        expect(axios.delete).toHaveBeenCalledWith(URL, expect.objectContaining({
            headers: expect.objectContaining({ 'Mcp-Session-Id': 'sess-9' })
        }));
        expect(client.sessionId).toBeNull();
    });

    test('is a no-op for a server that never issued a session', async () => {
        respondBy(HANDSHAKE);
        const client = new McpHttpClient({ url: URL });
        await client.initialize();
        await client.close();
        expect(axios.delete).not.toHaveBeenCalled();
    });

    test('swallows a failed teardown — the server times the session out anyway', async () => {
        axios.post.mockImplementation(async (_url, payload) => (
            payload.method === 'initialize'
                ? jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }, { headers: { 'mcp-session-id': 'sess-9' } })
                : acceptedResponse()
        ));
        axios.delete.mockRejectedValue(new Error('connection reset'));

        const client = new McpHttpClient({ url: URL });
        await client.initialize();
        await expect(client.close()).resolves.toBeUndefined();
    });
});

describe('a server that is rate-limiting us', () => {
    const { retryAfterMs, MAX_RETRY_AFTER_MS } = require('../src/services/ai/mcp/client');

    // 429 with a Retry-After. The stream is a body the client has to let go of
    // before it dials again, which is the part a mock catches and a live server
    // would only show as a leak.
    function rateLimited(retryAfter) {
        const data = Readable.from(['slow down']);
        jest.spyOn(data, 'destroy');
        return {
            status: 429,
            headers: { 'content-type': 'text/plain', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
            data
        };
    }

    describe('waiting it out', () => {
        test('retries once when the wait is short enough', async () => {
            const refused = rateLimited('0');
            axios.post
                .mockResolvedValueOnce(refused)
                .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: INIT_RESULT }))
                .mockResolvedValueOnce(acceptedResponse())
                .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }] } }));

            const client = new McpHttpClient({ url: URL });
            await expect(client.listTools()).resolves.toEqual([{ name: 'search' }]);
            // The refused response's body is a stream the client has to let go
            // of before it dials again; a live server would only show that as a
            // socket nobody closed.
            expect(refused.data.destroy).toHaveBeenCalled();
        });

        test('gives up rather than looping when the retry is refused too', async () => {
            // Once, not until it works: a server that means it will keep
            // meaning it, and the reply is waiting.
            axios.post
                .mockResolvedValueOnce(rateLimited('0'))
                .mockResolvedValueOnce(rateLimited('0'));

            const client = new McpHttpClient({ url: URL });
            await expect(client.listTools()).rejects.toThrow(/rate-limiting/);
            expect(axios.post).toHaveBeenCalledTimes(2);
        });

        test('reports a 429 that never said how long', async () => {
            axios.post.mockResolvedValueOnce(rateLimited(null));

            const client = new McpHttpClient({ url: URL });
            await expect(client.listTools()).rejects.toThrow(/rate-limiting this connection/);
            expect(axios.post).toHaveBeenCalledTimes(1);
        });

        test('reports a 429 asking for longer than a reply can wait', async () => {
            axios.post.mockResolvedValueOnce(rateLimited('600'));

            const client = new McpHttpClient({ url: URL });
            await expect(client.listTools()).rejects.toThrow(/HTTP 429/);
            expect(axios.post).toHaveBeenCalledTimes(1);
        });
    });

    describe('reading how long it asked for', () => {
        test('a count of seconds', () => {
            expect(retryAfterMs('2')).toBe(2000);
            expect(retryAfterMs('0')).toBe(0);
        });

        test('an HTTP date, which is the other form in the wild', () => {
            const soon = new Date(Date.now() + 2000).toUTCString();
            expect(retryAfterMs(soon)).toBeGreaterThan(0);
            expect(retryAfterMs(soon)).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
        });

        test('nothing, for a wait the reply cannot sit through', () => {
            // A server asking for a minute is telling us to come back later,
            // not to hold a Discord message open.
            expect(retryAfterMs('60')).toBeNull();
            expect(retryAfterMs(new Date(Date.now() + 120000).toUTCString())).toBeNull();
        });

        test('nothing, for a header that is missing or nonsense', () => {
            expect(retryAfterMs(undefined)).toBeNull();
            expect(retryAfterMs(null)).toBeNull();
            expect(retryAfterMs('')).toBeNull();
            expect(retryAfterMs('soon')).toBeNull();
        });

        test('nothing, for a date already in the past', () => {
            expect(retryAfterMs(new Date(Date.now() - 5000).toUTCString())).toBeNull();
        });
    });
});
