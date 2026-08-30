'use strict';

// The transport MCP had before Streamable HTTP (#838), and the negotiation
// between them.
//
// The older shape splits a connection in two: a long-lived GET that answers
// text/event-stream and names a second URL in its first event, and POSTs to
// that URL which are answered 202 with an empty body — the JSON-RPC response
// comes back down the standing stream some time later, matched by id. A large
// number of deployed servers still speak only this, Atlassian's among them,
// and to all of them a bare Streamable HTTP POST is a 404 or a 405.
//
// What is worth testing is the seams: that the fallback is tried on exactly
// those statuses and not others, that a URL with nothing behind it reports the
// first failure rather than the second, that a response arriving on a shared
// socket reaches the request that asked for it, and that the endpoint the
// *server* names cannot send this bot's credential somewhere else.

jest.mock('axios');

const { PassThrough, Readable } = require('stream');
const axios = require('axios');
const { McpHttpClient, McpError } = require('../src/services/ai/mcp/client');
const { resolveEndpoint } = require('../src/services/ai/mcp/sse');

const URL_ = 'https://mcp.example.com/sse';
const MESSAGES = 'https://mcp.example.com/messages?sessionId=abc';

const INIT_RESULT = {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'Legacy MCP', version: '0.9.0' },
};

/** The standing GET stream, plus the handles a test needs to drive it. */
function openChannel({ endpoint = '/messages?sessionId=abc', contentType = 'text/event-stream' } = {}) {
    const stream = new PassThrough();
    const channel = {
        stream,
        /** Push a raw SSE frame. */
        raw: text => stream.write(text),
        /** Push one JSON-RPC message as a `message` event. */
        send: message => stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
        end: () => stream.end(),
    };

    axios.get.mockImplementation(async () => {
        if (endpoint !== null) {
            // Named on the next tick, the way a real server does: after the
            // response headers, not with them.
            setImmediate(() => stream.write(`event: endpoint\ndata: ${endpoint}\n\n`));
        }
        return { status: 200, headers: { 'content-type': contentType }, data: stream };
    });

    return channel;
}

/**
 * Answers every POST 202, and replies on the channel to whichever methods the
 * test described — which is what a server on this transport actually does.
 */
function replyOnChannel(channel, handlers) {
    axios.post.mockImplementation(async (url, payload) => {
        expect(url).toBe(MESSAGES);
        if (payload.id !== undefined && payload.method in handlers) {
            const handler = handlers[payload.method];
            const body = typeof handler === 'function' ? handler(payload) : handler;
            if (body !== null) setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, ...body }));
        }
        return { status: 202, headers: {}, data: Readable.from([]) };
    });
}

const HANDSHAKE = {
    initialize: { result: INIT_RESULT },
    'notifications/initialized': null,
};

function textResponse(body, status) {
    return { status, headers: { 'content-type': 'text/plain' }, data: Readable.from([body]) };
}

function jsonResponse(body) {
    return { status: 200, headers: { 'content-type': 'application/json' }, data: Readable.from([JSON.stringify(body)]) };
}

beforeEach(() => {
    jest.clearAllMocks();
    // The fallback announces itself, and the both-transports-failed path warns.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('choosing a transport', () => {
    test.each([404, 405])('falls back to HTTP+SSE when the handshake POST answers %i', async status => {
        const channel = openChannel();
        let refused = false;
        axios.post.mockImplementation(async (url, payload) => {
            if (!refused) { refused = true; return textResponse('not here', status); }
            expect(url).toBe(MESSAGES);
            if (payload.method === 'initialize') {
                setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }));
            }
            return { status: 202, headers: {}, data: Readable.from([]) };
        });

        const client = new McpHttpClient({ url: URL_ });
        await client.initialize();

        expect(client.transport).toBe('sse');
        expect(client.serverInfo).toEqual(INIT_RESULT.serverInfo);
        // The GET is the configured URL; the POSTs go to the endpoint it named.
        expect(axios.get).toHaveBeenCalledWith(URL_, expect.anything());
        client.close();
    });

    test('offers the older revision when it has fallen back', async () => {
        const channel = openChannel();
        let refused = false;
        axios.post.mockImplementation(async (_url, payload) => {
            if (!refused) { refused = true; return textResponse('nope', 405); }
            if (payload.method === 'initialize') {
                expect(payload.params.protocolVersion).toBe('2024-11-05');
                setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }));
            }
            return { status: 202, headers: {}, data: Readable.from([]) };
        });

        const client = new McpHttpClient({ url: URL_ });
        await client.initialize();
        expect.assertions(2);
        expect(client.protocolVersion).toBe('2024-11-05');
        client.close();
    });

    test.each([401, 403, 429, 500])('does not fall back on HTTP %i, which is not a wrong transport', async status => {
        axios.post.mockResolvedValue(textResponse('denied', status));
        // No retry-after, so the 429 is an answer rather than a wait.
        const client = new McpHttpClient({ url: URL_ });

        await expect(client.initialize()).rejects.toThrow(McpError);
        expect(axios.get).not.toHaveBeenCalled();
        expect(client.transport).toBe('auto');
    });

    test('reports the POST failure, not the stream failure, when neither works', async () => {
        axios.post.mockResolvedValue(textResponse('nothing here', 404));
        axios.get.mockResolvedValue(textResponse('nothing here either', 404));

        const client = new McpHttpClient({ url: URL_ });
        // A pasted typo fails both ways, and what is wrong with it is that
        // there is no MCP server there — not anything about event streams.
        await expect(client.initialize()).rejects.toThrow(/no MCP endpoint/);
        // And the client is left willing to try both again rather than pinned
        // to the transport that also did not work.
        expect(client.transport).toBe('auto');
    });

    test('stays on Streamable HTTP when the POST works', async () => {
        axios.post.mockImplementation(async (_url, payload) => (
            payload.id === undefined
                ? { status: 202, headers: {}, data: Readable.from([]) }
                : jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT })
        ));

        const client = new McpHttpClient({ url: URL_ });
        await client.initialize();

        expect(client.transport).toBe('auto');
        expect(axios.get).not.toHaveBeenCalled();
    });
});

describe('talking over the standing stream', () => {
    let client;
    let channel;

    beforeEach(async () => {
        channel = openChannel();
        replyOnChannel(channel, HANDSHAKE);
        client = new McpHttpClient({ url: URL_, transport: 'sse' });
        await client.initialize();
    });

    afterEach(() => client.close());

    test('opens the stream once, however many requests follow', async () => {
        replyOnChannel(channel, {
            ...HANDSHAKE,
            'tools/list': { result: { tools: [{ name: 'search' }] } },
        });

        await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('routes a response to the request that asked for it, whatever order they arrive in', async () => {
        // Answered out of order and after a pause, which is the case a single
        // shared socket makes possible and a per-request stream cannot.
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                const delay = payload.params.name === 'slow' ? 20 : 1;
                setTimeout(() => channel.send({
                    jsonrpc: '2.0', id: payload.id,
                    result: { content: [{ type: 'text', text: payload.params.name }] },
                }), delay);
            }
            return { status: 202, headers: {}, data: Readable.from([]) };
        });

        const [slow, quick] = await Promise.all([
            client.callTool('slow', {}),
            client.callTool('quick', {}),
        ]);
        expect(slow.content[0].text).toBe('slow');
        expect(quick.content[0].text).toBe('quick');
    });

    test('delivers progress to the call that asked for it and to nobody else', async () => {
        const slowProgress = [];
        const quickProgress = [];

        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                const token = payload.params._meta.progressToken;
                setImmediate(() => {
                    channel.send({
                        jsonrpc: '2.0',
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: 1, total: 2 },
                    });
                    channel.send({ jsonrpc: '2.0', id: payload.id, result: { content: [] } });
                });
            }
            return { status: 202, headers: {}, data: Readable.from([]) };
        });

        await Promise.all([
            client.callTool('slow', {}, { onProgress: p => slowProgress.push(p) }),
            client.callTool('quick', {}, { onProgress: p => quickProgress.push(p) }),
        ]);

        // One notification each, matched on the token rather than on the socket
        // — which is the only filter available when every call shares one.
        expect(slowProgress).toEqual([{ progress: 1, total: 2, message: null }]);
        expect(quickProgress).toEqual([{ progress: 1, total: 2, message: null }]);
    });

    test('answers a server request on a POST of its own', async () => {
        const asked = [];
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                setImmediate(() => {
                    channel.send({ jsonrpc: '2.0', id: 9001, method: 'elicitation/create', params: { message: 'Which repo?' } });
                    setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: { content: [] } }));
                });
            }
            if (payload.id === 9001) asked.push(payload);
            return { status: 202, headers: {}, data: Readable.from([]) };
        });

        await client.callTool('search', {}, {
            onElicit: params => ({ action: 'accept', content: { repo: params.message } }),
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(asked).toHaveLength(1);
        expect(asked[0].result).toEqual({ action: 'accept', content: { repo: 'Which repo?' } });
    });

    test('refuses a method it does not serve rather than leaving the server waiting', async () => {
        const answers = [];
        axios.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                setImmediate(() => {
                    channel.send({ jsonrpc: '2.0', id: 7, method: 'roots/list', params: {} });
                    setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: { content: [] } }));
                });
            }
            if (payload.id === 7) answers.push(payload);
            return { status: 202, headers: {}, data: Readable.from([]) };
        });

        await client.callTool('search', {});
        await new Promise(resolve => setImmediate(resolve));

        expect(answers[0].error.code).toBe(-32601);
    });

    test('fails everything in flight when the stream dies, and forgets the session', async () => {
        axios.post.mockResolvedValue({ status: 202, headers: {}, data: Readable.from([]) });

        const call = client.callTool('search', {});
        await new Promise(resolve => setImmediate(resolve));
        channel.end();

        await expect(call).rejects.toMatchObject({ sessionExpired: true });
        // The session on this transport *is* the stream, so the next caller has
        // to handshake again rather than post to an endpoint that is gone.
        expect(client.initialized).toBe(false);
        expect(client.pending.size).toBe(0);
    });

    test('ignores a keepalive that is not JSON', async () => {
        replyOnChannel(channel, { ...HANDSHAKE, 'tools/list': { result: { tools: [{ name: 'search' }] } } });
        channel.raw(': ping\n\n');
        channel.raw('event: message\ndata: not json\n\n');

        await expect(client.listTools()).resolves.toEqual([{ name: 'search' }]);
    });
});

describe('the endpoint a server names', () => {
    test('is resolved against the configured URL, since it is relative in practice', () => {
        expect(resolveEndpoint('/messages?sessionId=abc', URL_, 'test'))
            .toBe('https://mcp.example.com/messages?sessionId=abc');
    });

    test('may be absolute, as long as it is the same host', () => {
        expect(resolveEndpoint('https://mcp.example.com/rpc', URL_, 'test'))
            .toBe('https://mcp.example.com/rpc');
    });

    test.each([
        ['another public host', 'https://evil.example.com/messages'],
        ['a different port on the same host', 'https://mcp.example.com:8443/messages'],
        ['a different scheme', 'http://mcp.example.com/messages'],
    ])('is refused when it points at %s', (_label, endpoint) => {
        // The credential and the guild's tool arguments go to this URL. A
        // server that can redirect them anywhere is a server that can read them.
        expect(() => resolveEndpoint(endpoint, URL_, 'test')).toThrow(/not the host it was configured as/);
    });

    test('is refused when it is not a URL at all', () => {
        expect(() => resolveEndpoint('http://[', URL_, 'test')).toThrow(/not a URL/);
    });

    test('closes the stream when the server never names one', async () => {
        // A server that answers text/event-stream and then says nothing must
        // not hold the handshake open: on this transport there is no response
        // body to time out, only a socket that stays quiet.
        const channel = openChannel({ endpoint: null });
        const client = new McpHttpClient({ url: URL_, transport: 'sse' });
        jest.useFakeTimers();
        try {
            // The assertion is attached before the clock moves, not after: the
            // rejection lands inside advanceTimersByTimeAsync, and a promise
            // that rejects with nothing yet watching it is an unhandled one.
            const initializing = expect(client.initialize()).rejects.toThrow(/never named its message endpoint/);
            // advanceTimersByTimeAsync, not the synchronous form: the GET and
            // the stream setup are promises, and a timer advanced before they
            // have run fires against a channel that is not open yet.
            await jest.advanceTimersByTimeAsync(20000);
            await initializing;
            expect(channel.stream.destroyed).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('refuses a stream the server did not answer as an event stream', async () => {
        openChannel({ contentType: 'text/html' });
        const client = new McpHttpClient({ url: URL_, transport: 'sse' });
        await expect(client.initialize()).rejects.toThrow(/text\/event-stream/);
    });
});
