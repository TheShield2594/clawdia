'use strict';

/**
 * #796, the dashboard half: starting a flow, coming back from the consent
 * screen, and forgetting a grant.
 *
 * The callback is the interesting one. It is a GET a browser is redirected to
 * from somebody else's site, so it can carry neither an Origin the CSRF check
 * would accept nor a body — and what stands in for that is the `state`: 32
 * random bytes this process issued and stored, looked up and deleted in one
 * operation so a replayed callback finds nothing. These pin that the lookup is
 * really the authorization, that the guild comes from the flow record and never
 * from the URL, and that a second callback cannot spend the code again.
 */

const express = require('express');

jest.mock('../src/models/Guild');
jest.mock('../src/models/McpOAuthState');
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn(async () => {}),
}));

const mockInspect = jest.fn();
jest.mock('../src/services/ai/mcp/inspect', () => ({ inspectServer: (...a) => mockInspect(...a) }));

const mockResetCache = jest.fn();
jest.mock('../src/services/ai/mcp/connections', () => ({ resetMcpCache: (...a) => mockResetCache(...a) }));

const mockDiscover = jest.fn();
const mockRegister = jest.fn();
const mockExchange = jest.fn();
jest.mock('../src/services/ai/mcp/oauth', () => {
    const actual = jest.requireActual('../src/services/ai/mcp/oauth');
    return {
        ...actual,
        discover: (...a) => mockDiscover(...a),
        registerClient: (...a) => mockRegister(...a),
        exchangeCode: (...a) => mockExchange(...a),
    };
});

const mockSaveGrant = jest.fn(async () => true);
const mockClearGrant = jest.fn(async () => true);
const mockReadGrant = jest.fn(async () => null);
jest.mock('../src/services/ai/mcp/oauthStore', () => ({
    saveGrant: (...a) => mockSaveGrant(...a),
    clearGrant: (...a) => mockClearGrant(...a),
    readGrant: (...a) => mockReadGrant(...a),
}));

const Guild = require('../src/models/Guild');
const McpOAuthState = require('../src/models/McpOAuthState');
const { logAuditEvent } = require('../src/dashboard/lib/apiHelpers');
const oauthRouter = require('../src/dashboard/routes/api/mcpOAuth');

const DISCOVERY = {
    issuer: 'https://auth.example.com',
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    registrationEndpoint: 'https://auth.example.com/register',
    resource: 'https://mcp.example.com/mcp',
    scopesSupported: ['read'],
};

const STORED = {
    name: 'linear',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
    allowedTools: [],
    blockedTools: [],
};

let server;
let baseUrl;

async function api(method, path, body) {
    const resp = await fetch(baseUrl + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* the callback answers with HTML */ }
    return { status: resp.status, body: parsed, text };
}

function stubServer(stored) {
    Guild.findOne = jest.fn(() => ({
        lean: async () => (stored ? { ai: { mcpServers: [stored] } } : null),
    }));
}

// `redirectUriFor` reads DASHBOARD_URL at call time, so these tests set it —
// and put back whatever the process had, including nothing at all, rather than
// leaving a value behind for whichever suite runs next in this worker.
const originalDashboardUrl = process.env.DASHBOARD_URL;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', oauthRouter);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    if (originalDashboardUrl === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = originalDashboardUrl;
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    jest.clearAllMocks();
    process.env.DASHBOARD_URL = 'https://dash.example.com';
    stubServer(STORED);
    mockInspect.mockResolvedValue({
        success: false,
        needsOAuth: true,
        message: 'HTTP 401',
        wwwAuthenticate: 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    });
    mockDiscover.mockResolvedValue(DISCOVERY);
    mockRegister.mockResolvedValue({ clientId: 'cid', clientSecret: 'shh', tokenEndpointAuthMethod: 'client_secret_post' });
    mockSaveGrant.mockResolvedValue(true);
    McpOAuthState.create = jest.fn(async doc => doc);
    McpOAuthState.findByIdAndDelete = jest.fn(() => ({ lean: async () => null }));
    McpOAuthState.deleteMany = jest.fn(async () => ({}));
});

describe('starting a flow', () => {
    test('discovers from the challenge, registers, and hands back a URL to open', async () => {
        const { status, body } = await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');

        expect(status).toBe(200);
        expect(mockDiscover).toHaveBeenCalledWith(
            'https://mcp.example.com/mcp',
            { resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource' },
        );

        const url = new URL(body.authorizationUrl);
        expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('scope')).toBe('read');
    });

    // One fixed redirect URI, not one per guild: it is registered with the
    // authorization server, sometimes by hand, and has to be a single string.
    test('uses one redirect URI, with no guild in it', async () => {
        await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');

        expect(mockRegister).toHaveBeenCalledWith(
            DISCOVERY.registrationEndpoint,
            expect.objectContaining({ redirectUri: 'https://dash.example.com/api/mcp/oauth/callback' }),
        );
    });

    test('stores the verifier against the state, with the guild and server it is for', async () => {
        const { body } = await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');
        const flow = McpOAuthState.create.mock.calls[0][0];

        expect(flow).toMatchObject({ guildId: 'g1', server: 'linear', clientId: 'cid', startedBy: 'admin-1' });
        expect(flow._id).toBe(new URL(body.authorizationUrl).searchParams.get('state'));
        // The challenge in the URL is the hash of the verifier that was stored,
        // never the verifier itself.
        expect(body.authorizationUrl).not.toContain(flow.verifier);
        expect(flow.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    /**
     * The two secrets on a transient record. An abandoned flow is exactly the
     * one most likely to still be sitting there when somebody reads a backup,
     * and the client secret is the same value the finished grant stores sealed.
     *
     * Driven through the real model rather than the mock this file installs,
     * with a key actually configured — without one `encryptSecret` is the
     * identity function, so a test run against the default environment would
     * pass whether or not the setters were there at all.
     */
    test('seals the verifier and the client secret before storing them', () => {
        const secretBox = jest.requireActual('../src/config/secretBox');
        const previousKey = process.env.SECRET_ENCRYPTION_KEY;
        process.env.SECRET_ENCRYPTION_KEY = 'test-key-for-mcp-oauth-state';
        secretBox._resetSecretBox();

        try {
            const RealModel = jest.requireActual('../src/models/McpOAuthState');
            const flow = new RealModel({
                _id: 'st', guildId: 'g1', server: 'linear',
                verifier: 'the-verifier', redirectUri: 'https://dash.example.com/cb',
                discovery: {}, clientId: 'cid', clientSecret: 'shh',
                expiresAt: new Date(Date.now() + 60_000),
            });

            expect(flow.verifier).not.toBe('the-verifier');
            expect(flow.clientSecret).not.toBe('shh');
            expect(secretBox.isEncrypted(flow.verifier)).toBe(true);
            expect(secretBox.isEncrypted(flow.clientSecret)).toBe(true);
            // And the callback can get them back, which is the half that makes
            // the flow still work.
            expect(secretBox.decryptSecret(flow.verifier)).toBe('the-verifier');
            expect(secretBox.decryptSecret(flow.clientSecret)).toBe('shh');
        } finally {
            if (previousKey === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
            else process.env.SECRET_ENCRYPTION_KEY = previousKey;
            secretBox._resetSecretBox();
        }
    });

    // A flow for a connection that already works would send an admin through a
    // consent screen for nothing.
    test('refuses when the server answers happily without a login', async () => {
        mockInspect.mockResolvedValue({ success: true, needsOAuth: false, message: 'Connected' });

        const { status, body } = await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');

        expect(status).toBe(400);
        expect(body.error).toMatch(/nothing to authorize/);
        expect(McpOAuthState.create).not.toHaveBeenCalled();
    });

    test('refuses when the failure is not an OAuth challenge', async () => {
        mockInspect.mockResolvedValue({ success: false, needsOAuth: false, message: 'HTTP 404 — no MCP endpoint at this URL' });

        const { status, body } = await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');

        expect(status).toBe(400);
        expect(body.error).toContain('HTTP 404');
    });

    // Without dynamic registration somebody has to create the client by hand,
    // and the one thing they need is the redirect URI to register.
    test('names the redirect URI when the server cannot register clients', async () => {
        mockDiscover.mockResolvedValue({ ...DISCOVERY, registrationEndpoint: null });

        const { status, body } = await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');

        expect(status).toBe(400);
        expect(body.redirectUri).toBe('https://dash.example.com/api/mcp/oauth/callback');
    });

    test('404s for a connection that does not exist', async () => {
        stubServer(null);
        const { status } = await api('POST', '/guild/g1/mcp-servers/nope/oauth/start');
        expect(status).toBe(404);
    });

    test('reports a discovery failure as the admin\'s problem, not a 500', async () => {
        const { OAuthError } = jest.requireActual('../src/services/ai/mcp/oauth');
        mockDiscover.mockRejectedValue(new OAuthError('token endpoint must be https'));

        const { status, body } = await api('POST', '/guild/g1/mcp-servers/linear/oauth/start');

        expect(status).toBe(400);
        expect(body.error).toBe('token endpoint must be https');
    });
});

describe('coming back from the consent screen', () => {
    const FLOW = {
        _id: 'st',
        guildId: 'g1',
        server: 'linear',
        verifier: 'ver',
        redirectUri: 'https://dash.example.com/api/mcp/oauth/callback',
        discovery: DISCOVERY,
        clientId: 'cid',
        clientSecret: 'shh',
        startedBy: 'admin-1',
    };

    beforeEach(() => {
        McpOAuthState.findByIdAndDelete = jest.fn(() => ({ lean: async () => FLOW }));
        mockExchange.mockResolvedValue({
            accessToken: 'at', refreshToken: 'rt',
            expiresAt: new Date(Date.now() + 3600_000), scope: 'read', tokenType: 'Bearer',
        });
    });

    test('exchanges the code and stores the grant against the flow\'s guild', async () => {
        const { status, text } = await api('GET', '/mcp/oauth/callback?state=st&code=abc');

        expect(status).toBe(200);
        expect(mockExchange).toHaveBeenCalledWith(DISCOVERY, expect.objectContaining({
            code: 'abc', verifier: 'ver', clientId: 'cid', clientSecret: 'shh',
        }));
        // The guild comes from the stored flow, never from anything in the URL.
        expect(mockSaveGrant).toHaveBeenCalledWith('g1', 'linear', expect.objectContaining({
            accessToken: 'at', refreshToken: 'rt', connectedBy: 'admin-1',
        }));
        expect(text).toContain('Connected');
    });

    // The pooled client was built when there was no grant, so it holds no token
    // and its cached tool list is whatever an unauthenticated server answered.
    test('drops the connection cache so the next message uses the new login', async () => {
        await api('GET', '/mcp/oauth/callback?state=st&code=abc');
        expect(mockResetCache).toHaveBeenCalled();
    });

    // The admin who started the flow, not whoever holds the session on return.
    test('records who connected what', async () => {
        await api('GET', '/mcp/oauth/callback?state=st&code=abc');

        const [reqLike, guildId, action, details] = logAuditEvent.mock.calls[0];
        expect([guildId, action]).toEqual(['g1', 'mcp_oauth_connect']);
        expect(details).toMatchObject({ name: 'linear', issuer: DISCOVERY.issuer });
        expect(reqLike.user).toEqual({ id: 'admin-1' });
        // `logAuditEvent` reads `ip` and `get('user-agent')` off what it is
        // handed. A plain `{ user }` throws inside its own try/catch, which
        // loses the only record of who connected a grant — in silence.
        expect(typeof reqLike.get).toBe('function');
        expect(() => reqLike.get('user-agent')).not.toThrow();
    });

    // The helper is mocked above, so nothing else here would notice the shim
    // being wrong. This runs the real one against it — inside
    // `isolateModules`, because `logAuditEvent` requires its model lazily and a
    // `doMock` left in the registry would hand the stub to any later test that
    // reached for it.
    test('and the record actually gets written', async () => {
        await api('GET', '/mcp/oauth/callback?state=st&code=abc');
        const [reqLike, guildId, action, details] = logAuditEvent.mock.calls[0];

        const created = [];
        await new Promise((resolve, reject) => {
            jest.isolateModules(() => {
                jest.doMock('../src/models/AuditLog', () => ({
                    create: async doc => { created.push(doc); },
                }));
                const realHelper = jest.requireActual('../src/dashboard/lib/apiHelpers');
                realHelper.logAuditEvent(reqLike, guildId, action, details).then(resolve, reject);
            });
        });
        jest.dontMock('../src/models/AuditLog');

        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ guildId: 'g1', userId: 'admin-1', action: 'mcp_oauth_connect' });
    });

    // Read and delete in one operation, so a refreshed tab or a kept link finds
    // nothing the second time rather than spending the code again.
    test('a state nobody issued goes no further', async () => {
        McpOAuthState.findByIdAndDelete = jest.fn(() => ({ lean: async () => null }));

        const { status, text } = await api('GET', '/mcp/oauth/callback?state=forged&code=abc');

        expect(status).toBe(400);
        expect(text).toMatch(/already been used, or has expired/);
        expect(mockExchange).not.toHaveBeenCalled();
    });

    test('the flow is consumed before the code is spent', async () => {
        const order = [];
        McpOAuthState.findByIdAndDelete = jest.fn(() => ({ lean: async () => { order.push('consume'); return FLOW; } }));
        mockExchange.mockImplementation(async () => {
            order.push('exchange');
            return { accessToken: 'at', refreshToken: 'rt', expiresAt: null, scope: null };
        });

        await api('GET', '/mcp/oauth/callback?state=st&code=abc');

        expect(order).toEqual(['consume', 'exchange']);
    });

    // The admin clicked Deny, or the consent expired. Reported before the state
    // lookup so the message says what happened rather than "unknown flow".
    test('reports the authorization server\'s refusal in its own words', async () => {
        const { status, text } = await api(
            'GET',
            '/mcp/oauth/callback?error=access_denied&error_description=The%20user%20said%20no',
        );

        expect(status).toBe(400);
        expect(text).toContain('The user said no');
        expect(McpOAuthState.findByIdAndDelete).not.toHaveBeenCalled();
    });

    // The error description is written by the authorization server, and the
    // page it lands on is HTML.
    test('escapes what the server sent rather than rendering it', async () => {
        const { text } = await api(
            'GET',
            `/mcp/oauth/callback?error=x&error_description=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
        );

        expect(text).not.toContain('<img');
        expect(text).toContain('&lt;img');
    });

    test('a callback with no code says so instead of throwing', async () => {
        const { status, text } = await api('GET', '/mcp/oauth/callback?state=st');
        expect(status).toBe(400);
        expect(text).toMatch(/Incomplete callback/);
    });

    test('a connection removed mid-flow is reported rather than half-stored', async () => {
        mockSaveGrant.mockResolvedValue(false);

        const { status, text } = await api('GET', '/mcp/oauth/callback?state=st&code=abc');

        expect(status).toBe(400);
        expect(text).toMatch(/removed while you were authorizing/);
    });

    test('a refused exchange says what the server said', async () => {
        const { OAuthError } = jest.requireActual('../src/services/ai/mcp/oauth');
        mockExchange.mockRejectedValue(new OAuthError('code already used', { status: 400 }));

        const { status, text } = await api('GET', '/mcp/oauth/callback?state=st&code=abc');

        expect(status).toBe(400);
        expect(text).toContain('code already used');
    });
});

describe('signing out', () => {
    test('drops the grant, any half-finished flow, and the cached connection', async () => {
        mockReadGrant.mockResolvedValue({ issuer: DISCOVERY.issuer });

        const { status, body } = await api('DELETE', '/guild/g1/mcp-servers/linear/oauth');

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(mockClearGrant).toHaveBeenCalledWith('g1', 'linear');
        expect(McpOAuthState.deleteMany).toHaveBeenCalledWith({ guildId: 'g1', server: 'linear' });
        expect(mockResetCache).toHaveBeenCalled();
    });

    test('404s when there is no login stored', async () => {
        mockReadGrant.mockResolvedValue(null);

        const { status } = await api('DELETE', '/guild/g1/mcp-servers/linear/oauth');

        expect(status).toBe(404);
        expect(mockClearGrant).not.toHaveBeenCalled();
    });
});
