'use strict';

// The Streamable HTTP MCP client. Anthropic used to open these connections, so
// none of this existed; now the bot is the client for every other provider and
// the transport details are load-bearing — the session header, the initialized
// notification, and the fact that a server may answer a POST with an SSE stream
// rather than a JSON body.

jest.mock('axios');

const { Readable } = require('stream');
const axios = require('axios');
const { McpHttpClient, McpError, CALL_TIMEOUT_MS } = require('../src/services/ai/mcp/client');

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

/**
 * #796. An OAuth connection's credential is not a field on the client — it is a
 * grant in the database that expires within the hour and rotates. So the token
 * is asked for before every request rather than once at construction, and a 401
 * is worth one forced refresh and one retry before it becomes an error somebody
 * has to read.
 */
describe('an OAuth connection', () => {
    /** A client whose token comes from a store, with the calls recorded. */
    function oauthClient(tokens) {
        const asked = [];
        const client = new McpHttpClient({
            url: URL,
            label: 'linear',
            getAccessToken: async ({ force }) => { asked.push(force); return tokens.shift() ?? null; }
        });
        return { client, asked };
    }

    // A pooled client can sit idle past its token's lifetime, and the store is
    // what knows when to refresh — so it is asked every time rather than once.
    test('asks the store for a token before every request', async () => {
        respondBy(HANDSHAKE);
        const { client, asked } = oauthClient(['at1', 'at1']);

        await client.initialize();

        expect(asked).toEqual([false, false]);
        expect(postsTo('initialize')[0][2].headers.Authorization).toBe('Bearer at1');
    });

    test('refreshes once and retries when the server rejects the token', async () => {
        let seen = 0;
        axios.post.mockImplementation(async (_url, payload, options) => {
            if (payload.method === 'initialize' && seen++ === 0) {
                return textResponse('', 401);
            }
            expect(options.headers.Authorization).toBe('Bearer at2');
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
        });

        const { client, asked } = oauthClient(['at1', 'at2', 'at2']);
        await client.initialize();

        // False for the ordinary pre-request fetch, then true for the forced
        // one the 401 asked for.
        expect(asked.slice(0, 2)).toEqual([false, true]);
    });

    // A second identical request buys nothing, and a second 401 after a fresh
    // token is the server saying no rather than a clock problem.
    test('does not retry twice, or with a token that did not change', async () => {
        axios.post.mockResolvedValue(textResponse('', 401));
        const { client } = oauthClient(['at1', 'at1', 'at1']);

        await expect(client.initialize()).rejects.toThrow(/401/);
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    // A 401 with a Bearer challenge is a server asking for a login, not a bad
    // token, and the dashboard offers Connect on the difference.
    test('carries the challenge on the error, so discovery knows where to start', async () => {
        axios.post.mockResolvedValue({
            status: 401,
            headers: {
                'content-type': 'text/plain',
                'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
            },
            data: Readable.from([''])
        });

        const error = await new McpHttpClient({ url: URL }).initialize().catch(err => err);

        expect(error.needsOAuth).toBe(true);
        expect(error.wwwAuthenticate).toContain('resource_metadata');
        expect(error.message).toMatch(/OAuth login/);
    });

    test('a 401 with no challenge is still just a rejected token', async () => {
        axios.post.mockResolvedValue(textResponse('nope', 401));

        const error = await new McpHttpClient({ url: URL, authorizationToken: 'x' }).initialize().catch(err => err);

        expect(error.needsOAuth).toBe(false);
        expect(error.message).toMatch(/rejected the authorization token/);
    });

    // A static-token connection has no store to ask, and must not gain a retry
    // it never had.
    test('leaves a static-token connection exactly as it was', async () => {
        axios.post.mockResolvedValue(textResponse('nope', 401));

        await expect(new McpHttpClient({ url: URL, authorizationToken: 'x' }).initialize()).rejects.toThrow();
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    // A store that cannot produce a token is not an error: the request goes out
    // unauthenticated and fails with the server's own message, which is more
    // useful than one invented here.
    test('carries on unauthenticated when the store has nothing', async () => {
        respondBy(HANDSHAKE);
        const { client } = oauthClient([null, null]);

        await client.initialize();

        expect(postsTo('initialize')[0][2].headers.Authorization).toBeUndefined();
    });

    test('and when the store throws', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        respondBy(HANDSHAKE);
        const client = new McpHttpClient({
            url: URL, label: 'linear',
            getAccessToken: async () => { throw new Error('mongo down'); }
        });

        await expect(client.initialize()).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
        warn.mockRestore();
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

    /**
     * #838. A `list_changed` is about the connection rather than about any one
     * request, so nobody is waiting for it: it arrives on whatever stream
     * happens to be open, and without a connection-level listener it was read
     * off the wire and dropped.
     */
    test('forwards every notification to the connection-level listener', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return sseResponse([
                { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
                { jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'search' }] } }
            ]);
        });

        const seen = [];
        const client = new McpHttpClient({ url: URL, onNotification: n => seen.push(n.method) });
        await client.listTools();

        expect(seen).toContain('notifications/tools/list_changed');
    });

    // Nobody asked for progress here, which used to mean no listener was passed
    // at all and every notification on the stream went unread.
    test('and does so on a request that asked for no progress', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return sseResponse([
                { jsonrpc: '2.0', method: 'notifications/resources/list_changed' },
                { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'ok' }] } }
            ]);
        });

        const seen = [];
        const client = new McpHttpClient({ url: URL, onNotification: n => seen.push(n.method) });
        const result = await client.callTool('search', {});

        expect(seen).toEqual(['notifications/resources/list_changed']);
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    });

    // Both audiences want every notification, and neither may cost the other
    // one — a progress reader that throws is a bug in the caller, not a reason
    // to miss the server saying its tool list moved.
    test('a per-request listener that throws does not cost the connection one', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return sseResponse([
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: payload.params._meta.progressToken, progress: 1 } },
                { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
                { jsonrpc: '2.0', id: payload.id, result: { content: [] } }
            ]);
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const seen = [];
        const client = new McpHttpClient({ url: URL, onNotification: n => seen.push(n.method) });
        await client.callTool('search', {}, { onProgress: () => { throw new Error('listener bug'); } });

        expect(seen).toEqual(['notifications/progress', 'notifications/tools/list_changed']);
        warn.mockRestore();
    });

    test('forwards progress notifications to a caller that asked for them', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return sseResponse([
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: payload.params._meta.progressToken, progress: 3, total: 10, message: 'indexing' } },
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: payload.params._meta.progressToken, progress: 7, total: 10 } },
                { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'done' }] } }
            ]);
        });

        const seen = [];
        const result = await new McpHttpClient({ url: URL })
            .callTool('search', { q: 'x' }, { onProgress: update => seen.push(update) });

        expect(seen).toEqual([
            { progress: 3, total: 10, message: 'indexing' },
            { progress: 7, total: 10, message: null }
        ]);
        expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    });

    test('asks for progress with a token, and only when somebody is listening', async () => {
        // A server sends notifications for a request that carried a token and
        // for no other, so a caller with nothing to show is not sent updates it
        // would only throw away.
        respondBy({ ...HANDSHAKE, 'tools/call': { result: { content: [] } } });

        const client = new McpHttpClient({ url: URL });
        await client.callTool('search', {});
        expect(postsTo('tools/call')[0][1].params._meta).toBeUndefined();

        await client.callTool('search', {}, { onProgress: () => {} });
        const call = postsTo('tools/call')[1][1];
        expect(call.params._meta.progressToken).toBe(call.id);
        // The arguments still arrive intact beside it.
        expect(call.params.name).toBe('search');
    });

    test('ignores progress for somebody else\'s request', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return sseResponse([
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'someone-else', progress: 1 } },
                // A progress notification with no number in it says nothing.
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: payload.params._meta.progressToken } },
                { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } },
                { jsonrpc: '2.0', id: payload.id, result: { content: [] } }
            ]);
        });

        const seen = [];
        await new McpHttpClient({ url: URL }).callTool('search', {}, { onProgress: u => seen.push(u) });
        expect(seen).toEqual([]);
    });

    test('a listener that throws does not cost the tool result', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return sseResponse([
                { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: payload.params._meta.progressToken, progress: 1 } },
                { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'still here' }] } }
            ]);
        });

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await new McpHttpClient({ url: URL }).callTool('search', {}, {
            onProgress: () => { throw new Error('listener bug'); }
        });

        expect(result.content).toEqual([{ type: 'text', text: 'still here' }]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('a caller\'s deadline can shorten a tool call but never lengthen it', async () => {
        respondBy({ ...HANDSHAKE, 'tools/call': { result: { content: [] } } });
        const client = new McpHttpClient({ url: URL });

        await client.callTool('search', {}, { timeout: 3000 });
        expect(postsTo('tools/call')[0][2].timeout).toBe(3000);

        // A caller asking for longer than the call timeout does not get it.
        await client.callTool('search', {}, { timeout: 10 * 60 * 1000 });
        expect(postsTo('tools/call')[1][2].timeout).toBe(CALL_TIMEOUT_MS);

        // And no deadline at all is the timeout it always was.
        await client.callTool('search', {});
        expect(postsTo('tools/call')[2][2].timeout).toBe(CALL_TIMEOUT_MS);
    });

    test('reports a stream that ends without answering', async () => {
        axios.post.mockImplementation(async (_url, payload) =>
            payload.method === 'notifications/initialized' ? acceptedResponse() : sseResponse([]));

        await expect(new McpHttpClient({ url: URL }).initialize())
            .rejects.toThrow(/closed the stream/);
    });

    test('a stream that never answers is cut off at the deadline (#816)', async () => {
        // 200 with event-stream headers, then silence: axios's own timeout only
        // covers the headers, so this is the shape that used to hang forever.
        const hanging = new Readable({ read() {} });
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return { status: 200, headers: { 'content-type': 'text/event-stream' }, data: hanging };
        });

        const client = new McpHttpClient({ url: URL });
        await expect(client.callTool('search', {}, { timeout: 50 }))
            .rejects.toThrow(/no answer before the deadline/);
        // The socket is released, not left open behind the settled promise.
        expect(hanging.destroyed).toBe(true);
    });

    test('an error body that never arrives is cut off at the deadline too', async () => {
        const hanging = new Readable({ read() {} });
        axios.post.mockImplementation(async () => ({
            status: 500, headers: { 'content-type': 'text/plain' }, data: hanging
        }));

        const client = new McpHttpClient({ url: URL });
        await expect(client.post({ jsonrpc: '2.0', id: 1, method: 'x' }, { id: 1, timeout: 50 }))
            .rejects.toThrow(/no answer before the deadline/);
        expect(hanging.destroyed).toBe(true);
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

// The two families a tool loop does not need, and the reason the client asks
// about them at all: a server's resources are a knowledge base kept by whoever
// owns the documents, and its prompts are templates `/ai mcp prompt` can run.
describe('resources and prompts', () => {
    const WITH_ALL = {
        ...INIT_RESULT,
        capabilities: { tools: {}, resources: {}, prompts: {} }
    };
    const handshakeWith = capabilities => ({
        initialize: { result: { ...INIT_RESULT, capabilities } },
        'notifications/initialized': null
    });

    test('lists resources, following the cursor', async () => {
        respondBy({
            ...handshakeWith(WITH_ALL.capabilities),
            'resources/list': payload => (payload.params.cursor
                ? { result: { resources: [{ uri: 'wiki://b' }] } }
                : { result: { resources: [{ uri: 'wiki://a' }], nextCursor: 'page-2' } })
        });

        const resources = await new McpHttpClient({ url: URL }).listResources();
        expect(resources.map(r => r.uri)).toEqual(['wiki://a', 'wiki://b']);
    });

    test('drops a resource with no URI, which is nothing that can be read', async () => {
        respondBy({
            ...handshakeWith({ resources: {} }),
            'resources/list': { result: { resources: [{ uri: 'wiki://a' }, { name: 'nameless' }] } }
        });

        expect(await new McpHttpClient({ url: URL }).listResources()).toEqual([{ uri: 'wiki://a' }]);
    });

    test('never asks a server for something its handshake did not claim', async () => {
        respondBy(handshakeWith({ tools: {} }));

        const client = new McpHttpClient({ url: URL });
        expect(await client.listResources()).toEqual([]);
        expect(await client.listPrompts()).toEqual([]);
        expect(postsTo('resources/list')).toHaveLength(0);
        expect(postsTo('prompts/list')).toHaveLength(0);
    });

    test('a server that claims a capability and then refuses it has answered "none"', async () => {
        respondBy({
            ...handshakeWith({ prompts: {} }),
            'prompts/list': { error: { code: -32601, message: 'Method not found' } }
        });

        expect(await new McpHttpClient({ url: URL }).listPrompts()).toEqual([]);
    });

    test('reads one resource and hands back its contents', async () => {
        respondBy({
            ...handshakeWith({ resources: {} }),
            'resources/read': { result: { contents: [{ uri: 'wiki://a', text: 'body' }] } }
        });

        const contents = await new McpHttpClient({ url: URL }).readResource('wiki://a');
        expect(contents).toEqual([{ uri: 'wiki://a', text: 'body' }]);
        expect(postsTo('resources/read')[0][1].params).toEqual({ uri: 'wiki://a' });
    });

    test('fills in a prompt, sending every argument as a string', async () => {
        respondBy({
            ...handshakeWith({ prompts: {} }),
            'prompts/get': { result: { description: 'Review', messages: [{ role: 'user', content: { type: 'text', text: 'go' } }] } }
        });

        const prompt = await new McpHttpClient({ url: URL }).getPrompt('review', { pr: 42, skip: null });
        expect(postsTo('prompts/get')[0][1].params).toEqual({ name: 'review', arguments: { pr: '42' } });
        expect(prompt.messages).toHaveLength(1);
    });

    test('two families asked for at once share one handshake', async () => {
        respondBy({
            ...handshakeWith({ resources: {}, prompts: {} }),
            'resources/list': { result: { resources: [{ uri: 'wiki://a' }] } },
            'prompts/list': { result: { prompts: [{ name: 'review' }] } }
        });

        // Nothing orders these two: `/ai mcp prompts` can land while a message
        // is reading the same server's resources. Two handshakes would mean two
        // sessions, and the second notifications/initialized landing against
        // whichever session id came back last.
        const client = new McpHttpClient({ url: URL });
        await Promise.all([client.listResources(), client.listPrompts()]);

        expect(postsTo('initialize')).toHaveLength(1);
        expect(postsTo('notifications/initialized')).toHaveLength(1);
    });

    test('a prompt that comes back shapeless is empty rather than undefined', async () => {
        respondBy({ ...handshakeWith({ prompts: {} }), 'prompts/get': { result: {} } });
        expect(await new McpHttpClient({ url: URL }).getPrompt('review', {}))
            .toEqual({ description: '', messages: [] });
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

/**
 * #838. Elicitation is the one exchange that runs the other way: the server
 * sends a *request* down the stream its tool result is still coming on, and
 * waits for an answer. Two things make it different from everything else here
 * — the answer goes back on a POST of its own, because the transport has no way
 * to write up the stream it arrived on, and the clock has to stop, because what
 * the client is doing in the meantime is asking a person.
 */
describe('a request from the server', () => {
    /** A stream that asks a question, then answers the tool call. */
    function askingStream(payload, params) {
        return sseResponse([
            { jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params },
            { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'done' }] } }
        ]);
    }

    function serverThatAsks(params = { message: 'which one?', requestedSchema: { type: 'object', properties: {} } }) {
        const answers = [];
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            // A JSON-RPC message with no method is the client answering us.
            if (!payload.method) {
                answers.push(payload);
                return acceptedResponse();
            }
            return askingStream(payload, params);
        });
        return answers;
    }

    /** Waits for the answer POST, which is deliberately not awaited in-band. */
    const settled = async answers => {
        for (let i = 0; i < 20 && !answers.length; i++) await new Promise(r => setImmediate(r));
        return answers;
    };

    test('reaches the handler the call carried, with the server\'s params', async () => {
        serverThatAsks({ message: 'which repo?', requestedSchema: { type: 'object', properties: { repo: { type: 'string' } } } });
        const seen = [];

        await new McpHttpClient({ url: URL, elicitation: true }).callTool('deploy', {}, {
            onElicit: async params => { seen.push(params); return { action: 'accept', content: { repo: 'clawdia' } }; }
        });

        expect(seen).toEqual([{ message: 'which repo?', requestedSchema: { type: 'object', properties: { repo: { type: 'string' } } } }]);
    });

    test('and the answer goes back as a JSON-RPC response with the server\'s id', async () => {
        const answers = serverThatAsks();

        await new McpHttpClient({ url: URL, elicitation: true }).callTool('deploy', {}, {
            onElicit: async () => ({ action: 'accept', content: { repo: 'clawdia' } })
        });

        await settled(answers);
        expect(answers[0]).toEqual({
            jsonrpc: '2.0',
            id: 'srv-1',
            result: { action: 'accept', content: { repo: 'clawdia' } }
        });
    });

    // The tool result is still coming down the original stream while a person
    // reads the question, so the question must not block the read.
    test('the tool result still arrives while the question is outstanding', async () => {
        serverThatAsks();
        let release;
        const asked = new Promise(resolve => { release = resolve; });

        const result = await new McpHttpClient({ url: URL, elicitation: true }).callTool('deploy', {}, {
            onElicit: () => asked.then(() => ({ action: 'decline' }))
        });

        expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
        release();
    });

    // The capability is the connection's and the person is the request's, so a
    // scheduled task reaches here with nobody to ask. `cancel` is the spec's
    // "no choice was made", which is exactly true.
    test('with nobody to ask, it is answered cancel rather than left hanging', async () => {
        const answers = serverThatAsks();

        await new McpHttpClient({ url: URL, elicitation: true }).callTool('deploy', {});

        await settled(answers);
        expect(answers[0]).toMatchObject({ id: 'srv-1', result: { action: 'cancel' } });
    });

    /** Answers `method` from the server mid-tool-call, and collects the reply. */
    function serverThatAsksFor(method) {
        const answers = [];
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            if (!payload.method) { answers.push(payload); return acceptedResponse(); }
            return sseResponse([
                { jsonrpc: '2.0', id: 'srv-9', method, params: {} },
                { jsonrpc: '2.0', id: payload.id, result: { content: [] } }
            ]);
        });
        return answers;
    }

    // A server that gets no answer waits for one, so an unsupported method has
    // to be refused rather than ignored: silence is a tool call that hangs
    // until its deadline instead of failing in a sentence.
    test('a method this client does not serve is refused, not ignored', async () => {
        // roots/list is the one deliberate absence: this client is a Discord
        // bot and has no filesystem for a server to work inside.
        const answers = serverThatAsksFor('roots/list');

        await new McpHttpClient({ url: URL, elicitation: true }).callTool('think', {});

        await settled(answers);
        expect(answers[0].error).toMatchObject({ code: -32601, message: expect.stringContaining('roots/list') });
    });

    // Sampling *is* served, but only for a turn that has somebody to approve
    // the spend. A request with nobody behind it is an error rather than a
    // cancel, because a completion has no "declined" shape to send back (#838).
    test('a sampling request with nobody to authorise it is an error, not a cancel', async () => {
        const answers = serverThatAsksFor('sampling/createMessage');

        await new McpHttpClient({ url: URL, sampling: true }).callTool('think', {});

        await settled(answers);
        expect(answers[0].result).toBeUndefined();
        expect(answers[0].error).toMatchObject({ code: -32603, message: expect.stringContaining('authorise') });
    });

    test('a handler that throws becomes an error response, not a hang', async () => {
        const answers = serverThatAsks();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await new McpHttpClient({ url: URL, elicitation: true }).callTool('deploy', {}, {
            onElicit: async () => { throw new Error('the channel is gone'); }
        });

        await settled(answers);
        expect(answers[0].error).toMatchObject({ code: -32603, message: 'the channel is gone' });
        warn.mockRestore();
    });
});

/**
 * The clock. A tool call is bounded so a Discord reply cannot be held open
 * forever, and `readWithDeadline` enforces that by destroying the stream. An
 * elicitation puts the exchange in front of a person, and the seconds they
 * spend reading it are not the server being slow — without moving the deadline,
 * the call the question belongs to is killed underneath the prompt still
 * sitting in the channel, and the server is left holding a request nobody will
 * ever answer.
 */
/**
 * Each side of a JSON-RPC connection numbers its own outgoing requests, so the
 * two counters share a namespace by accident and will eventually collide: a
 * server that has sent a few requests over a pooled session lands on the id of
 * the call in flight. A message carrying a `method` is never a response,
 * whatever id it has, and reading it as one is the difference between a
 * question that gets answered and a tool that reports no output while the
 * server waits out a request nobody will ever see.
 */
describe('a server request whose id collides with ours', () => {
    test('is not mistaken for the answer to our call', async () => {
        const answers = [];
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            if (!payload.method) { answers.push(payload); return acceptedResponse(); }
            return sseResponse([
                // The server's own request, numbered the same as ours.
                { jsonrpc: '2.0', id: payload.id, method: 'elicitation/create', params: { message: 'which?' } },
                { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'the real answer' }] } }
            ]);
        });

        const client = new McpHttpClient({ url: URL, elicitation: true });
        const result = await client.callTool('deploy', {}, {
            onElicit: async () => ({ action: 'decline' })
        });

        expect(result.content).toEqual([{ type: 'text', text: 'the real answer' }]);
        for (let i = 0; i < 20 && !answers.length; i++) await new Promise(r => setImmediate(r));
        // Answered under the id the *server* used, which is the same number
        // our call carried — that collision is the whole point of this test.
        expect(answers[0]).toMatchObject({ result: { action: 'decline' } });
        expect(answers[0].id).toBe(2);
    });

    // Same reasoning for a batched JSON body, which may carry the server's own
    // requests alongside the answer.
    test('and not in a batched JSON body either', async () => {
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            return jsonResponse([
                { jsonrpc: '2.0', id: payload.id, method: 'ping' },
                { jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'search' }] } }
            ]);
        });

        await expect(new McpHttpClient({ url: URL }).listTools()).resolves.toEqual([{ name: 'search' }]);
    });
});

describe('the deadline while somebody is answering', () => {
    /** A stream held open by the test, so the deadline is what decides. */
    function heldStream() {
        const stream = new Readable({ read() {} });
        return {
            stream,
            push: event => stream.push(`event: message\ndata: ${JSON.stringify(event)}\n\n`),
            end: () => stream.push(null),
        };
    }

    test('is pushed out by the handler, so the call outlives its original budget', async () => {
        const held = heldStream();
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            if (!payload.method) return acceptedResponse();
            callId = payload.id;
            setImmediate(() => held.push({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: {} }));
            return { status: 200, headers: { 'content-type': 'text/event-stream' }, data: held.stream };
        });

        let callId;
        let answered;
        const client = new McpHttpClient({ url: URL, elicitation: true });
        const call = client.callTool('deploy', {}, {
            timeout: 60,
            onElicit: (_params, { extendDeadline }) => {
                extendDeadline(5000);
                return new Promise(resolve => { answered = resolve; });
            }
        });

        // Comfortably past the 60ms the call started with. Without the
        // extension the stream is destroyed here and the call rejects.
        await new Promise(resolve => setTimeout(resolve, 250));
        answered({ action: 'accept', content: {} });
        held.push({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'deployed' }] } });

        await expect(call).resolves.toMatchObject({ content: [{ type: 'text', text: 'deployed' }] });
    });

    // The extension is not a reprieve from the clock, only a longer one: a
    // server that asks and then goes away still loses the call rather than
    // holding a Discord reply open indefinitely.
    test('and still expires when nobody answers at all', async () => {
        const held = heldStream();
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            if (payload.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT });
            if (!payload.method) return acceptedResponse();
            setImmediate(() => held.push({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: {} }));
            return { status: 200, headers: { 'content-type': 'text/event-stream' }, data: held.stream };
        });

        const client = new McpHttpClient({ url: URL, elicitation: true });
        await expect(client.callTool('deploy', {}, {
            timeout: 60,
            onElicit: (_params, { extendDeadline }) => {
                extendDeadline(150);
                return new Promise(() => {});
            }
        })).rejects.toThrow(/before the deadline/);
    });
});

describe('what the client tells a server it can do', () => {
    async function capabilitiesOf(options) {
        let sent;
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'initialize') sent = payload.params.capabilities;
            if (payload.method === 'notifications/initialized') return acceptedResponse();
            return jsonResponse({ jsonrpc: '2.0', id: payload.id, result: payload.method === 'initialize' ? INIT_RESULT : { tools: [] } });
        });
        await new McpHttpClient({ url: URL, ...options }).listTools();
        return sent;
    }

    test('nothing at all, when there is nobody to ask', async () => {
        expect(await capabilitiesOf({})).toEqual({});
    });

    test('elicitation, when there is', async () => {
        expect(await capabilitiesOf({ elicitation: true })).toEqual({ elicitation: {} });
    });

    // A capability is a promise to answer, and these two are promises this
    // client should not make: `roots` offers a filesystem for a server to work
    // inside, and a Discord bot has none; `sampling` is a server asking to
    // spend the guild's model budget, which wants the ledger and the
    // confirmation the tool loop already has rather than a declaration.
    test('and never roots or sampling', async () => {
        const capabilities = await capabilitiesOf({ elicitation: true });
        expect(capabilities).not.toHaveProperty('roots');
        expect(capabilities).not.toHaveProperty('sampling');
    });
});
