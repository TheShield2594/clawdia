'use strict';

// #559: `ai.ollamaBaseUrl` is a dashboard setting any guild admin can write, and
// it reached the HTTP client unexamined — the one user-supplied fetch in the bot
// that went around safeFeedFetch's guard, with the response echoed back into a
// Discord channel. From inside the container that is a read primitive against
// the operator's own network.
//
// Two halves are tested here, because either alone is bypassable: the syntactic
// check the dashboard applies when the setting is saved, and the resolver-level
// check applied when the request is actually made (DNS at save time says
// nothing about DNS an hour later).

const http = require('http');

const {
    guardedLookup, guardedDispatcher, assertPublicHttpUrl, assertHttpsUrl,
} = require('../src/utils/outboundGuard');
const { jsonResponse, textResponse, payloadOf } = require('./helpers/fetchResponse');
const ollama = require('../src/services/ai/providers/ollama');
const { validateAiUpdate } = require('../src/dashboard/routes/api/settings');

const lookup = (hostname, options = {}) => new Promise((resolve, reject) => {
    guardedLookup(hostname, options, (err, ...rest) => (err ? reject(err) : resolve(rest)));
});

describe('guardedLookup', () => {
    test.each([
        ['127.0.0.1', 'loopback'],
        ['169.254.169.254', 'the cloud metadata address'],
        ['10.1.2.3', 'RFC1918'],
        ['172.16.0.9', 'RFC1918'],
        ['192.168.1.1', 'RFC1918'],
        ['::1', 'IPv6 loopback'],
    ])('refuses %s (%s)', async address => {
        await expect(lookup(address)).rejects.toMatchObject({ code: 'EPRIVATEADDR' });
    });

    test('allows a public address, in both the shapes Node asks for', async () => {
        await expect(lookup('8.8.8.8')).resolves.toEqual(['8.8.8.8', 4]);
        await expect(lookup('8.8.8.8', { all: true })).resolves.toEqual([
            [{ address: '8.8.8.8', family: 4 }],
        ]);
    });

    // Happy Eyeballs asks for every address; a name answering with one public
    // and one private address must not be allowed on the public one.
    test('refuses a hostname whose answers are not all public', async () => {
        const dns = require('dns');
        const spy = jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
            cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
        });
        try {
            await expect(lookup('split-horizon.example')).rejects.toMatchObject({ code: 'EPRIVATEADDR' });
        } finally {
            spy.mockRestore();
        }
    });
});

describe('assertPublicHttpUrl', () => {
    test.each([
        'file:///etc/passwd',
        'gopher://127.0.0.1:11211/_stats',
        'redis://cache:6379',
        'not a url',
        '',
        'http://user:password@ollama.example.com:11434',
        'http://169.254.169.254/latest/meta-data',
        'http://127.0.0.1:27017',
        'http://[::1]:11434',
        'http://10.0.0.5:27017',
    ])('rejects %s', raw => {
        expect(() => assertPublicHttpUrl(raw, 'ai.ollamaBaseUrl')).toThrow(/ai\.ollamaBaseUrl/);
    });

    test('accepts a plain http(s) URL and hands back the parsed form', () => {
        expect(assertPublicHttpUrl('https://ollama.example.com:11434').host).toBe('ollama.example.com:11434');
    });
});

describe('settings validation for ai.ollamaBaseUrl', () => {
    test('rejects a scheme the provider should never dial', () => {
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'file:///etc/passwd' }))
            .toMatch(/ai\.ollamaBaseUrl must use http/);
    });

    test('rejects the addresses the attack in #559 is written against', () => {
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'http://169.254.169.254/latest/meta-data' }))
            .toMatch(/private or reserved address/);
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'http://127.0.0.1:27017' }))
            .toMatch(/private or reserved address/);
    });

    test('rejects a non-string, and reads the field out of a whole-object write too', () => {
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 42 })).toBe('ai.ollamaBaseUrl must be a string');
        expect(validateAiUpdate({ ai: { ollamaBaseUrl: 'javascript:alert(1)' } })).toMatch(/ai\.ollamaBaseUrl/);
    });

    test('leaves empty and null alone — both mean "use the operator\'s endpoint"', () => {
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': '' })).toBeNull();
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': null })).toBeNull();
        expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'http://ollama.internal.example.com:11434' })).toBeNull();
    });

    test('ignores settings that are not ai settings', () => {
        expect(validateAiUpdate({ 'welcome.message': 'file:///etc/passwd' })).toBeNull();
    });

    // The form must accept what the request path allows, or an operator running
    // Ollama on a private address cannot enter it.
    test("accepts the operator's own endpoint even though it is private", () => {
        const saved = process.env.OLLAMA_BASE_URL;
        process.env.OLLAMA_BASE_URL = 'http://192.168.1.50:11434';
        try {
            expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'http://192.168.1.50:11434' })).toBeNull();
            expect(validateAiUpdate({ 'ai.ollamaBaseUrl': 'http://192.168.1.51:11434' })).toMatch(/private or reserved/);
        } finally {
            if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
            else process.env.OLLAMA_BASE_URL = saved;
        }
    });
});

describe('ollama endpoint policy', () => {
    const savedEnv = process.env.OLLAMA_BASE_URL;
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.OLLAMA_BASE_URL;
        else process.env.OLLAMA_BASE_URL = savedEnv;
    });

    test("the operator's own endpoint is dialled directly", () => {
        delete process.env.OLLAMA_BASE_URL;
        for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11434/', '']) {
            const { url, dispatcher } = ollama.resolveEndpoint(baseUrl);
            expect(url).toMatch(/\/api\/chat$/);
            // Undefined rather than a dispatcher of its own: that is what hands
            // the request to the global one, which is the point.
            expect(dispatcher).toBeUndefined();
        }
    });

    test('OLLAMA_BASE_URL names an operator endpoint, however private it is', () => {
        process.env.OLLAMA_BASE_URL = 'http://ollama.internal:11434';
        expect(ollama.resolveEndpoint('http://ollama.internal:11434').dispatcher).toBeUndefined();
    });

    // The attack from the issue: a guild admin points the setting at a host on
    // the compose network. The name is resolved through the guarded resolver,
    // which is where "mongodb" turns out to be private.
    test('any other endpoint is forced through the guarded dispatcher', () => {
        delete process.env.OLLAMA_BASE_URL;
        for (const baseUrl of ['http://mongodb:27017', 'http://localhost:27017', 'https://ollama.example.com']) {
            expect(ollama.resolveEndpoint(baseUrl).dispatcher).toBe(guardedDispatcher());
        }
    });

    // The other half of the issue's attack — a literal address, which no
    // resolver is ever asked about.
    test('a literal private address is refused outright', () => {
        delete process.env.OLLAMA_BASE_URL;
        for (const baseUrl of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:27017']) {
            expect(() => ollama.resolveEndpoint(baseUrl)).toThrow(/private or reserved address/);
        }
    });

    test('a base URL that is not http(s) is refused outright', () => {
        expect(() => ollama.resolveEndpoint('file:///etc/passwd')).toThrow(/ai\.ollamaBaseUrl/);
    });
});

describe('the provider actually uses the policy', () => {
    let mockFetch;
    beforeEach(() => {
        mockFetch = jest.spyOn(globalThis, 'fetch')
            .mockImplementation(async () => jsonResponse({ message: { content: 'hi' } }));
    });
    afterEach(() => mockFetch.mockRestore());

    const args = { model: 'llama3.2', systemPrompt: 's', history: [], prompt: 'p', temperature: 0.7, maxTokens: 64 };

    test('complete() sends the guarded dispatcher for a guild-supplied endpoint', async () => {
        await ollama.complete({ ...args, baseUrl: 'http://mongodb:27017' });

        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('http://mongodb:27017/api/chat');
        expect(init.dispatcher).toBe(guardedDispatcher());
        expect(payloadOf(mockFetch.mock.calls[0]).model).toBe('llama3.2');
    });

    test("complete() leaves the operator's endpoint on the global dispatcher", async () => {
        await ollama.complete({ ...args, baseUrl: 'http://localhost:11434' });

        expect(mockFetch.mock.calls[0][1].dispatcher).toBeUndefined();
    });

    test('stream() applies the same policy', async () => {
        mockFetch.mockImplementation(async () => jsonResponse({ done: true }));

        // eslint-disable-next-line no-unused-vars
        for await (const _chunk of ollama.stream({ ...args, baseUrl: 'http://attacker.example.com' })) { /* drain */ }

        expect(mockFetch.mock.calls[0][1].dispatcher).toBe(guardedDispatcher());
    });

    // A refused connection costs nothing, but an endpoint that answers 500 has
    // a body, and neither path here reads it — so both have to let it go or the
    // socket is held until the pool times it out (#985). Ollama is the provider
    // where this bites hardest: it is self-hosted, so a misconfigured one
    // answers non-2xx on every message rather than once.
    test.each([
        ['complete()', async baseUrl => ollama.complete({ ...args, baseUrl })],
        ['stream()', async baseUrl => {
            // eslint-disable-next-line no-unused-vars
            for await (const _chunk of ollama.stream({ ...args, baseUrl })) { /* drain */ }
        }],
    ])('%s lets go of a non-2xx body instead of holding its socket', async (_label, run) => {
        const errorPage = textResponse('model not found', 500);
        mockFetch.mockImplementation(async () => errorPage);

        await expect(run('http://ollama.example.com')).rejects.toThrow(/Ollama returned HTTP 500/);
        expect(errorPage.bodyUsed).toBe(true);
    });
});

// The whole point is that nothing reaches the address, so the test is a real
// server on a real loopback port that must never see a request.
describe('end to end: a private endpoint is not connected to', () => {
    let server;
    let port;
    let hits = 0;

    beforeAll(done => {
        server = http.createServer((req, res) => { hits++; res.end('{}'); });
        server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });
    afterAll(done => { server.close(() => done()); });

    const args = { model: 'llama3.2', systemPrompt: 's', history: [], prompt: 'p', temperature: 0.7, maxTokens: 64 };

    test('complete() against a literal loopback address is refused before the socket opens', async () => {
        await expect(ollama.complete({ ...args, baseUrl: `http://127.0.0.1:${port}` }))
            .rejects.toThrow(/private or reserved address/);

        expect(hits).toBe(0);
    });

    // The other half, and the one only the dispatcher can catch: a *name* is
    // not a literal, so `assertPublicHttpUrl` lets it through and the refusal
    // has to come from the resolver the connection is made with. `localhost` on
    // any port but the operator's is a guild-supplied endpoint like any other.
    test('complete() against a name that resolves to loopback is refused at the socket', async () => {
        await expect(ollama.complete({ ...args, baseUrl: `http://localhost:${port}` }))
            .rejects.toThrow(/private or reserved address/);

        expect(hits).toBe(0);
    });

    // Streaming goes through the same dispatcher, and it is the path that
    // carries the model's answer back into a Discord channel.
    test('stream() against that name is refused too', async () => {
        const drain = async () => {
            // eslint-disable-next-line no-unused-vars
            for await (const _chunk of ollama.stream({ ...args, baseUrl: `http://localhost:${port}` })) { /* drain */ }
        };

        await expect(drain()).rejects.toThrow(/private or reserved address/);
        expect(hits).toBe(0);
    });
});

describe('assertHttpsUrl', () => {
    // The guard above answers "can this address be reached"; this answers "can
    // this be read on the way", which is a different question and the one that
    // matters for a request carrying a bearer token (#985).
    test('accepts https and hands back the parsed URL', () => {
        expect(assertHttpsUrl('https://mcp.example.com/mcp').toString())
            .toBe('https://mcp.example.com/mcp');
    });

    test('refuses http, naming the scheme it was given', () => {
        expect(() => assertHttpsUrl('http://mcp.example.com/mcp', 'MCP server URL'))
            .toThrow(/MCP server URL must use https:\/\/ — refusing to send credentials over http:\/\//);
    });

    // There is no loopback escape hatch because there is nothing to except:
    // `isPrivateIp` covers 127.0.0.0/8, so a local endpoint over plain http is
    // already refused a step earlier, with or without this check.
    test('still refuses loopback for the older reason', () => {
        expect(() => assertHttpsUrl('http://127.0.0.1:8080/mcp'))
            .toThrow(/private or reserved address/);
    });

    test('keeps everything assertPublicHttpUrl refuses', () => {
        expect(() => assertHttpsUrl('')).toThrow(/non-empty URL/);
        expect(() => assertHttpsUrl('ftp://example.com')).toThrow(/http:\/\/ or https:\/\//);
        expect(() => assertHttpsUrl('https://user:pw@example.com')).toThrow(/must not embed credentials/);
    });
});
