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

const { PassThrough } = require('stream');
const { McpHttpClient, McpError } = require('../src/services/ai/mcp/client');
const { PassThrough: _PT } = require('stream');
const { resolveEndpoint, pumpEvents, MAX_EVENT_BYTES } = require('../src/services/ai/mcp/sse');
const { installHttpMock } = require('./helpers/httpMock');
const { deferred } = require('./helpers/deferred');
const { response, jsonResponse, textResponse, acceptedResponse } = require('./helpers/fetchResponse');

// The GET is the standing stream and the POSTs are the messages, so the two
// stay separate mocks even though `fetch` is one function.
let http;

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

    http.get.mockImplementation(async () => {
        if (endpoint !== null) {
            // Named on the next tick, the way a real server does: after the
            // response headers, not with them.
            setImmediate(() => stream.write(`event: endpoint\ndata: ${endpoint}\n\n`));
        }
        return response(stream, { headers: { 'content-type': contentType } });
    });

    return channel;
}

/**
 * Answers every POST 202, and replies on the channel to whichever methods the
 * test described — which is what a server on this transport actually does.
 */
function replyOnChannel(channel, handlers) {
    http.post.mockImplementation(async (url, payload) => {
        expect(url).toBe(MESSAGES);
        if (payload.id !== undefined && payload.method in handlers) {
            const handler = handlers[payload.method];
            const body = typeof handler === 'function' ? handler(payload) : handler;
            if (body !== null) setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, ...body }));
        }
        return acceptedResponse();
    });
}

const HANDSHAKE = {
    initialize: { result: INIT_RESULT },
    'notifications/initialized': null,
};

beforeEach(() => {
    jest.clearAllMocks();
    http = installHttpMock();
    // The fallback announces itself, and the both-transports-failed path warns.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('choosing a transport', () => {
    test.each([404, 405])('falls back to HTTP+SSE when the handshake POST answers %i', async status => {
        const channel = openChannel();
        let refused = false;
        http.post.mockImplementation(async (url, payload) => {
            if (!refused) { refused = true; return textResponse('not here', status); }
            expect(url).toBe(MESSAGES);
            if (payload.method === 'initialize') {
                setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }));
            }
            return acceptedResponse();
        });

        const client = new McpHttpClient({ url: URL_ });
        await client.initialize();

        expect(client.transport).toBe('sse');
        expect(client.serverInfo).toEqual(INIT_RESULT.serverInfo);
        // The GET is the configured URL; the POSTs go to the endpoint it named.
        expect(http.get).toHaveBeenCalledWith(URL_, undefined, expect.anything());
        client.close();
    });

    test('offers the older revision when it has fallen back', async () => {
        const channel = openChannel();
        let refused = false;
        http.post.mockImplementation(async (_url, payload) => {
            if (!refused) { refused = true; return textResponse('nope', 405); }
            if (payload.method === 'initialize') {
                expect(payload.params.protocolVersion).toBe('2024-11-05');
                setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT }));
            }
            return acceptedResponse();
        });

        const client = new McpHttpClient({ url: URL_ });
        await client.initialize();
        expect.assertions(2);
        expect(client.protocolVersion).toBe('2024-11-05');
        client.close();
    });

    test.each([401, 403, 429, 500])('does not fall back on HTTP %i, which is not a wrong transport', async status => {
        http.post.mockResolvedValue(textResponse('denied', status));
        // No retry-after, so the 429 is an answer rather than a wait.
        const client = new McpHttpClient({ url: URL_ });

        await expect(client.initialize()).rejects.toThrow(McpError);
        expect(http.get).not.toHaveBeenCalled();
        expect(client.transport).toBe('auto');
    });

    test('reports the POST failure, not the stream failure, when neither works', async () => {
        http.post.mockResolvedValue(textResponse('nothing here', 404));
        http.get.mockResolvedValue(textResponse('nothing here either', 404));

        const client = new McpHttpClient({ url: URL_ });
        // A pasted typo fails both ways, and what is wrong with it is that
        // there is no MCP server there — not anything about event streams.
        await expect(client.initialize()).rejects.toThrow(/no MCP endpoint/);
        // And the client is left willing to try both again rather than pinned
        // to the transport that also did not work.
        expect(client.transport).toBe('auto');
    });

    test('does not leave a stream open when the fallback handshake fails', async () => {
        const channel = openChannel();
        let refused = false;
        http.post.mockImplementation(async () => {
            if (!refused) { refused = true; return textResponse('not here', 405); }
            // The endpoint is named, so the stream is up — and then initialize
            // fails behind it. The client is about to go back to Streamable
            // HTTP, where nothing reads this socket.
            return textResponse('broken', 500);
        });

        const client = new McpHttpClient({ url: URL_ });
        await expect(client.initialize()).rejects.toThrow(McpError);

        expect(channel.stream.destroyed).toBe(true);
        expect(client.sse).toBeNull();
        expect(client.sseEndpoint).toBeNull();
    });

    test('stays on Streamable HTTP when the POST works', async () => {
        http.post.mockImplementation(async (_url, payload) => (
            payload.id === undefined
                ? acceptedResponse()
                : jsonResponse({ jsonrpc: '2.0', id: payload.id, result: INIT_RESULT })
        ));

        const client = new McpHttpClient({ url: URL_ });
        await client.initialize();

        expect(client.transport).toBe('auto');
        expect(http.get).not.toHaveBeenCalled();
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
        expect(http.get).toHaveBeenCalledTimes(1);
    });

    test('routes a response to the request that asked for it, whatever order they arrive in', async () => {
        // Answered out of order and after a pause, which is the case a single
        // shared socket makes possible and a per-request stream cannot.
        http.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                const delay = payload.params.name === 'slow' ? 20 : 1;
                setTimeout(() => channel.send({
                    jsonrpc: '2.0', id: payload.id,
                    result: { content: [{ type: 'text', text: payload.params.name }] },
                }), delay);
            }
            return acceptedResponse();
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

        http.post.mockImplementation(async (_url, payload) => {
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
            return acceptedResponse();
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

    test('answers a server request on a POST of its own, and survives the wait', async () => {
        // Only the clock the deadline is on. `setImmediate` and the microtask
        // queue stay real: the standing stream's frames are delivered through
        // them, and faking those stops the transport moving at all.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        const asked = [];
        let callId = null;
        http.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                callId = payload.id;
                setImmediate(() => channel.send({
                    jsonrpc: '2.0', id: 9001, method: 'elicitation/create', params: { message: 'Which repo?' },
                }));
            }
            if (payload.id === 9001) {
                asked.push(payload);
                // The tool answers only once it has what it asked for, which is
                // what a real server does — the question is blocking the call.
                setImmediate(() => channel.send({ jsonrpc: '2.0', id: callId, result: { content: [] } }));
            }
            return acceptedResponse();
        });

        // The handler takes three times the call's own deadline, which is what a
        // person reading a question in a channel does. It says so through
        // `extendDeadline`, and the call has to survive it — so the deadline
        // that moves has to be the one belonging to the call the question
        // arrived during. Looking it up by the *server's* request id finds
        // either nothing or an unrelated call of ours that happens to share the
        // number, since each side numbers its requests independently; either way
        // the tool call dies underneath the prompt still open in the channel.
        // Two handles and a driven clock, rather than a 300ms sleep racing a
        // 100ms deadline for the scheduler's attention (#949). `asking` says
        // the extension has actually been applied, so the advance past the
        // original deadline is meaningful; `answering` holds the handler open
        // across it, which is what a person reading a question in a channel
        // does.
        const asking = deferred();
        const answering = deferred();
        const call = client.callTool('search', {}, {
            timeout: 100,
            onElicit: async (params, { extendDeadline }) => {
                extendDeadline(5000);
                asking.resolve();
                await answering.promise;
                return { action: 'accept', content: { repo: params.message } };
            },
        });

        let result;
        try {
            await asking.promise;
            await jest.advanceTimersByTimeAsync(300);
            answering.resolve();
            result = await call;
        } finally {
            jest.useRealTimers();
        }

        expect(result).toEqual({ content: [], structuredContent: null, isError: false });
        expect(asked).toHaveLength(1);
        expect(asked[0].result).toEqual({ action: 'accept', content: { repo: 'Which repo?' } });
    });

    test('refuses a server request it cannot attribute to one turn', async () => {
        // This client is pooled by (url, credential), and for a tokenless
        // server that key has no guild in it — so two guilds pointed at the
        // same public server share one socket. Answering "whichever call is
        // newest" would put one guild's question in the other's channel and
        // bill the wrong ledger, so a request arriving while calls from more
        // than one turn are open is refused instead.
        const answers = [];
        const calls = [];
        http.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') calls.push(payload.id);
            if (payload.id === 4242) answers.push(payload);
            return acceptedResponse();
        });

        const askedIn = [];
        const handler = who => async () => { askedIn.push(who); return { action: 'accept', content: {} }; };
        const first = client.callTool('a', {}, { owner: Symbol('turn-a'), onElicit: handler('a') });
        const second = client.callTool('b', {}, { owner: Symbol('turn-b'), onElicit: handler('b') });
        await new Promise(resolve => setImmediate(resolve));

        channel.send({ jsonrpc: '2.0', id: 4242, method: 'elicitation/create', params: { message: 'which?' } });
        await new Promise(resolve => setImmediate(resolve));

        // Nobody was asked, and the server got the spec's "no choice was made"
        // rather than an answer belonging to whichever turn happened to be last.
        expect(askedIn).toEqual([]);
        expect(answers[0].result).toEqual({ action: 'cancel' });

        calls.forEach(id => channel.send({ jsonrpc: '2.0', id, result: { content: [] } }));
        await Promise.all([first, second]);
    });

    test('still answers when the calls in flight are all one turn', async () => {
        // The same guess is harmless inside a turn: same person, same channel,
        // same ledger. Only the attribution to one of that turn's calls is
        // approximate, and nothing depends on it.
        const turn = Symbol('one-turn');
        const answers = [];
        const calls = [];
        http.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') calls.push(payload.id);
            if (payload.id === 4243) answers.push(payload);
            return acceptedResponse();
        });

        const onElicit = async () => ({ action: 'accept', content: { ok: true } });
        const first = client.callTool('a', {}, { owner: turn, onElicit });
        const second = client.callTool('b', {}, { owner: turn, onElicit });
        await new Promise(resolve => setImmediate(resolve));

        channel.send({ jsonrpc: '2.0', id: 4243, method: 'elicitation/create', params: { message: 'which?' } });
        await new Promise(resolve => setImmediate(resolve));

        expect(answers[0].result).toEqual({ action: 'accept', content: { ok: true } });

        calls.forEach(id => channel.send({ jsonrpc: '2.0', id, result: { content: [] } }));
        await Promise.all([first, second]);
    });

    test('does not hang when a failed POST stalls its error body', async () => {
        // A streamed body means the request timeout bounds the wait for
        // headers only. A server that answers 500 and then stops writing used
        // to hang the read forever — before postOverSse installs its own
        // deadline on the reply — so the waiter sat in `pending` and the
        // caller's promise never settled either way.
        const stalled = new PassThrough();   // headers, then silence
        http.post.mockImplementation(async (_url, payload) => (
            payload.method === 'tools/list'
                ? response(stalled, { status: 500 })
                : acceptedResponse()
        ));

        jest.useFakeTimers();
        try {
            const listing = expect(client.listTools()).rejects.toThrow(McpError);
            await jest.advanceTimersByTimeAsync(60_000);
            await listing;
        } finally {
            jest.useRealTimers();
        }
        expect(client.pending.size).toBe(0);
    });

    test('refuses a method it does not serve rather than leaving the server waiting', async () => {
        const answers = [];
        http.post.mockImplementation(async (_url, payload) => {
            if (payload.method === 'tools/call') {
                setImmediate(() => {
                    channel.send({ jsonrpc: '2.0', id: 7, method: 'roots/list', params: {} });
                    setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: { content: [] } }));
                });
            }
            if (payload.id === 7) answers.push(payload);
            return acceptedResponse();
        });

        await client.callTool('search', {});
        await new Promise(resolve => setImmediate(resolve));

        expect(answers[0].error.code).toBe(-32601);
    });

    test('fails everything in flight when the stream dies, and forgets the session', async () => {
        http.post.mockResolvedValue(acceptedResponse());

        const call = client.callTool('search', {});
        await new Promise(resolve => setImmediate(resolve));
        channel.end();

        await expect(call).rejects.toMatchObject({ sessionExpired: true });
        // The session on this transport *is* the stream, so the next caller has
        // to handshake again rather than post to an endpoint that is gone.
        expect(client.initialized).toBe(false);
        expect(client.pending.size).toBe(0);
    });

    test('waits out a 429 the server put a bounded clock on, then re-sends', async () => {
        const posts = [];
        http.post.mockImplementation(async (_url, payload) => {
            posts.push(payload);
            // Only the first attempt at the list is refused.
            if (payload.method === 'tools/list' && posts.filter(p => p.method === 'tools/list').length === 1) {
                return response(null, { status: 429, headers: { 'retry-after': '0' } });
            }
            if (payload.method === 'tools/list') {
                setImmediate(() => channel.send({ jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'search' }] } }));
            }
            return acceptedResponse();
        });

        await expect(client.listTools()).resolves.toEqual([{ name: 'search' }]);
        // The same id both times: a 429 is the server refusing the message
        // rather than acting on it, so the waiter registered for it still holds.
        const attempts = posts.filter(p => p.method === 'tools/list');
        expect(attempts).toHaveLength(2);
        expect(attempts[0].id).toBe(attempts[1].id);
    });

    test('reports a 429 the turn cannot afford rather than sitting on it', async () => {
        http.post.mockImplementation(async (_url, payload) => (
            payload.method === 'tools/list'
                ? response(null, { status: 429, headers: { 'retry-after': '600' } })
                : acceptedResponse()
        ));

        await expect(client.listTools()).rejects.toThrow(/rate-limiting/);
        expect(client.pending.size).toBe(0);
    });

    test('ignores a keepalive that is not JSON', async () => {
        replyOnChannel(channel, { ...HANDSHAKE, 'tools/list': { result: { tools: [{ name: 'search' }] } } });
        channel.raw(': ping\n\n');
        channel.raw('event: message\ndata: not json\n\n');

        await expect(client.listTools()).resolves.toEqual([{ name: 'search' }]);
    });
});

describe('an expiring OAuth token on the older transport', () => {
    test('is refreshed once on a 401 and the message re-sent', async () => {
        // The credential and the server are the same ones Streamable HTTP would
        // meet; a connection that reconnected only on the newer transport would
        // be an OAuth server here failing every time its hourly token expired.
        // The store hands back the token it holds until it is told to refresh,
        // which is what an expiring grant looks like from here.
        let token = 'stale';
        const getAccessToken = jest.fn(async ({ force }) => {
            if (force) token = 'fresh';
            return token;
        });

        const channel = openChannel();
        const seen = [];
        http.post.mockImplementation(async (_url, payload, init) => {
            seen.push(init.headers.Authorization);
            // The handshake goes through on the stale token; it expires between
            // then and the list, which is the case that matters.
            if (payload.method === 'tools/list' && init.headers.Authorization === 'Bearer stale') {
                return textResponse('expired', 401);
            }
            if (payload.id !== undefined) {
                setImmediate(() => channel.send({
                    jsonrpc: '2.0', id: payload.id,
                    result: payload.method === 'initialize' ? INIT_RESULT : { tools: [] },
                }));
            }
            return acceptedResponse();
        });

        const client = new McpHttpClient({ url: URL_, transport: 'sse', getAccessToken });
        await expect(client.listTools()).resolves.toEqual([]);

        expect(getAccessToken).toHaveBeenCalledWith({ force: true });
        expect(seen).toContain('Bearer fresh');
        client.close();
    });
});

describe('the size of one event', () => {
    /**
     * Feeds `frames` through the parser and reports what came out, or the throw.
     *
     * One tick between writes so each frame is delivered as its own read. Piled
     * in together the stream coalesces them, which would let a test about
     * *accumulating* lines pass on a parser that only ever measured one read.
     */
    async function pump(frames) {
        const stream = new _PT();
        const events = [];
        const done = pumpEvents(stream, event => events.push(event));
        // Marked handled before the writes, and awaited after: the parser
        // rejects part-way through the loop below for the oversized cases, and
        // a rejection with nothing attached to it yet is an unhandled one
        // whatever ends up awaiting it a few ticks later.
        done.catch(() => {});
        for (const frame of frames) {
            // Refusing an event destroys the stream, and writing to a destroyed
            // one raises an error nobody is listening for.
            if (stream.destroyed) break;
            stream.write(frame);
            await new Promise(resolve => setImmediate(resolve));
        }
        if (!stream.destroyed) stream.end();
        await done;
        return events;
    }

    test('joins the data lines of one event', async () => {
        expect(await pump(['event: message\ndata: {"a":1,\ndata: "b":2}\n\n']))
            .toEqual([{ event: 'message', data: '{"a":1,\n"b":2}' }]);
    });

    test('refuses one enormous line', async () => {
        await expect(pump([`data: ${'x'.repeat(MAX_EVENT_BYTES + 10)}\n\n`]))
            .rejects.toThrow(/exceeded/);
    });

    test('refuses an event split across many small lines', async () => {
        // The cap used to be measured against the read buffer alone, which is
        // drained of every complete line on each pass — so a server sending one
        // enormous event as thousands of short `data:` lines kept the buffer
        // small the whole way down while the array behind it grew without
        // limit, and the ceiling never fired.
        const line = `data: ${'x'.repeat(9_000)}\n`;
        const frames = Array.from({ length: Math.ceil(MAX_EVENT_BYTES / 9_000) + 2 }, () => line);
        await expect(pump(frames)).rejects.toThrow(/exceeded/);
    });

    test('counts each event on its own, so a long session is not a large event', async () => {
        // The counter resets at the blank line. Otherwise the standing stream —
        // open for the life of the session and carrying every response — would
        // simply be a slow timer on a working connection.
        const chunk = `data: ${'x'.repeat(200_000)}\n\n`;
        const events = await pump(Array.from({ length: 40 }, () => chunk));
        expect(events).toHaveLength(40);
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
