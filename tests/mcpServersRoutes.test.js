'use strict';

// Drives the MCP dashboard routes through a real express app with the Guild
// model and auth middleware stubbed, so the handler logic — upsert semantics,
// the "omitted token means keep the stored one" rule, the per-guild cap — is
// exercised rather than described.

const express = require('express');

jest.mock('../src/models/Guild');
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next()
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn(async () => {})
}));
// The connection test dials the MCP server itself now, so this is the thing to
// stand in for — no AI provider is involved in it at all.
const mockListTools = jest.fn();
const mockClose = jest.fn(async () => {});
const mockConstructed = [];
jest.mock('../src/services/ai/mcp/client', () => ({
    McpHttpClient: class {
        constructor(options) {
            mockConstructed.push(options);
            this.serverInfo = { name: 'GitHub MCP Server' };
            this.listTools = mockListTools;
            this.listResources = async () => [];
            this.listPrompts = async () => [];
            this.close = mockClose;
        }
    }
}));

// The pool warm-up a save kicks off. Mocked rather than exercised: what
// matters at this layer is that the response does not wait on somebody else's
// server, and that a save which cannot reach it still succeeds.
const mockPrewarm = jest.fn(async () => 1);
jest.mock('../src/services/ai/mcp/toolkit', () => ({
    prewarmMcpServers: (...args) => mockPrewarm(...args)
}));

const mockGetToolUsage = jest.fn(async () => []);
jest.mock('../src/services/ai/mcp/usage', () => ({
    getToolUsage: (...args) => mockGetToolUsage(...args)
}));

const Guild = require('../src/models/Guild');
const { logAuditEvent } = require('../src/dashboard/lib/apiHelpers');
const mcpRouter = require('../src/dashboard/routes/api/mcpServers');

let server;
let baseUrl;
let doc;

// Stands in for the mongoose document: a plain object plus the save() the
// handler calls.
function makeDoc(servers) {
    return {
        guildId: 'g1',
        ai: { provider: 'anthropic', mcpServers: servers },
        save: jest.fn(async () => {}),
        toObject() { return { guildId: this.guildId, ai: this.ai }; }
    };
}

async function api(method, path, body) {
    const resp = await fetch(baseUrl + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: resp.status, body: await resp.json() };
}

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', mcpRouter);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    jest.clearAllMocks();
    mockPrewarm.mockResolvedValue(1);
    mockConstructed.length = 0;
    doc = makeDoc([]);
    // findOne().lean() is used by the read paths; the write path uses the doc.
    Guild.findOne = jest.fn(() => {
        const promise = Promise.resolve(doc);
        promise.lean = () => Promise.resolve(doc.toObject());
        return promise;
    });
    Guild.findOneAndUpdate = jest.fn(async () => doc);
});

describe('GET /guild/:id/mcp-servers', () => {
    test('lists stored servers without their tokens', async () => {
        doc = makeDoc([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true, authorizationToken: 'ghp_secret', allowedTools: [], blockedTools: [] }]);

        const { status, body } = await api('GET', '/guild/g1/mcp-servers');

        expect(status).toBe(200);
        expect(body.servers).toEqual([expect.objectContaining({ name: 'github', hasToken: true })]);
        expect(JSON.stringify(body)).not.toContain('ghp_secret');
    });

    test('offers the GitHub preset and reports the provider in use', async () => {
        const { body } = await api('GET', '/guild/g1/mcp-servers');
        expect(body.presets.map(p => p.id)).toContain('github');
        expect(body.provider).toBe('anthropic');
        expect(body.editable).toBe(true);
    });
});

describe('a saved server is dialled before it is needed', () => {
    // An admin who saves a connection is about to go and try it, and discovery
    // is the same handshake and list whenever it happens — so it happens here,
    // off the clock, rather than on the first Discord reply that needs it.
    test('the save warms the connection it just stored', async () => {
        await api('PUT', '/guild/g1/mcp-servers/github', {
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_secret'
        });

        expect(mockPrewarm).toHaveBeenCalledWith([expect.objectContaining({
            name: 'github',
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_secret'
        })]);
    });

    test('a server saved switched off is not dialled', async () => {
        await api('PUT', '/guild/g1/mcp-servers/github', {
            url: 'https://api.githubcopilot.com/mcp/',
            enabled: false
        });

        expect(mockPrewarm).not.toHaveBeenCalled();
    });

    test('a server that cannot be reached still saves', async () => {
        mockPrewarm.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const { status } = await api('PUT', '/guild/g1/mcp-servers/github', {
            url: 'https://api.githubcopilot.com/mcp/'
        });

        expect(status).toBe(200);
        expect(doc.save).toHaveBeenCalled();
        await new Promise(resolve => setImmediate(resolve));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('prewarm after save failed'));
        warn.mockRestore();
    });
});

describe('PUT /guild/:id/mcp-servers/:name', () => {
    test('adds a server and records who added it', async () => {
        const { status, body } = await api('PUT', '/guild/g1/mcp-servers/github', {
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_secret',
            blockedTools: ['delete_file']
        });

        expect(status).toBe(200);
        expect(doc.save).toHaveBeenCalled();
        expect(doc.ai.mcpServers[0]).toMatchObject({
            name: 'github',
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_secret',
            blockedTools: ['delete_file'],
            addedBy: 'admin-1'
        });
        expect(body.servers[0].hasToken).toBe(true);
        expect(JSON.stringify(body)).not.toContain('ghp_secret');
        expect(logAuditEvent).toHaveBeenCalledWith(
            expect.anything(), 'g1', 'mcp_server_add', expect.objectContaining({ name: 'github' })
        );
    });

    test('an omitted token on update keeps the stored one', async () => {
        doc = makeDoc([{ name: 'github', url: 'https://old.example.com/mcp', enabled: true, authorizationToken: 'ghp_keepme', allowedTools: [], blockedTools: [] }]);

        await api('PUT', '/guild/g1/mcp-servers/github', { url: 'https://api.githubcopilot.com/mcp/' });

        expect(doc.ai.mcpServers[0].authorizationToken).toBe('ghp_keepme');
        expect(doc.ai.mcpServers[0].url).toBe('https://api.githubcopilot.com/mcp/');
        expect(doc.ai.mcpServers).toHaveLength(1);
    });

    test('an explicit empty token clears the stored one', async () => {
        doc = makeDoc([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true, authorizationToken: 'ghp_old', allowedTools: [], blockedTools: [] }]);

        await api('PUT', '/guild/g1/mcp-servers/github', { url: 'https://api.githubcopilot.com/mcp/', authorizationToken: '' });

        expect(doc.ai.mcpServers[0].authorizationToken).toBeNull();
    });

    test('rejects a plaintext URL before anything is stored', async () => {
        const { status, body } = await api('PUT', '/guild/g1/mcp-servers/github', { url: 'http://api.example.com/mcp/' });
        expect(status).toBe(400);
        expect(body.error).toMatch(/https/);
        expect(doc.save).not.toHaveBeenCalled();
    });

    test('rejects a name the API would not accept', async () => {
        const { status } = await api('PUT', '/guild/g1/mcp-servers/' + encodeURIComponent('my server'), { url: 'https://api.example.com/mcp/' });
        expect(status).toBe(400);
    });

    test('caps how many servers one guild can add', async () => {
        doc = makeDoc(Array.from({ length: 10 }, (_, i) => ({ name: `srv${i}`, url: `https://s${i}.example.com/mcp`, enabled: true, allowedTools: [], blockedTools: [] })));

        const { status, body } = await api('PUT', '/guild/g1/mcp-servers/one-too-many', { url: 'https://extra.example.com/mcp' });

        expect(status).toBe(400);
        expect(body.error).toMatch(/At most/);
    });

    test('refuses writes when the operator disabled dashboard servers', async () => {
        process.env.MCP_ALLOW_GUILD_SERVERS = 'false';
        try {
            const { status } = await api('PUT', '/guild/g1/mcp-servers/github', { url: 'https://api.githubcopilot.com/mcp/' });
            expect(status).toBe(403);
            expect(doc.save).not.toHaveBeenCalled();
        } finally {
            delete process.env.MCP_ALLOW_GUILD_SERVERS;
        }
    });
});

describe('DELETE /guild/:id/mcp-servers/:name', () => {
    test('pulls the entry and audits it', async () => {
        doc = makeDoc([]);
        const { status } = await api('DELETE', '/guild/g1/mcp-servers/github');

        expect(status).toBe(200);
        expect(Guild.findOneAndUpdate).toHaveBeenCalledWith(
            { guildId: 'g1', 'ai.mcpServers.name': 'github' },
            { $pull: { 'ai.mcpServers': { name: 'github' } } },
            { new: true }
        );
        expect(logAuditEvent).toHaveBeenCalledWith(expect.anything(), 'g1', 'mcp_server_remove', { name: 'github' });
    });

    test('404s when there is nothing to remove', async () => {
        Guild.findOneAndUpdate = jest.fn(async () => null);
        const { status } = await api('DELETE', '/guild/g1/mcp-servers/nope');
        expect(status).toBe(404);
    });
});

describe('POST /guild/:id/mcp-servers/:name/test', () => {
    const stored = {
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        authorizationToken: 'ghp_good',
        allowedTools: [],
        blockedTools: ['delete_file']
    };

    test('404s for a server that was never added', async () => {
        const { status } = await api('POST', '/guild/g1/mcp-servers/ghost/test');
        expect(status).toBe(404);
    });

    test('connects with the stored url and token, and counts what the filters leave on', async () => {
        doc = makeDoc([stored]);
        mockListTools.mockResolvedValue([
            { name: 'search_repositories' },
            { name: 'get_file_contents' },
            { name: 'delete_file' }
        ]);

        const { status, body } = await api('POST', '/guild/g1/mcp-servers/github/test');

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(mockConstructed).toEqual([{
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_good',
            label: 'github'
        }]);
        expect(body.toolCount).toBe(3);
        // delete_file is blocked, so it is offered by the server but not enabled.
        expect(body.enabledCount).toBe(2);
        expect(body.tools).toEqual(['search_repositories', 'get_file_contents', 'delete_file']);
        expect(body.message).toMatch(/GitHub MCP Server/);
    });

    // The test used to spend an Anthropic call to find out whether a URL worked,
    // which meant a guild on any other provider could not run it at all.
    test('needs no AI provider key', async () => {
        doc = makeDoc([stored]);
        mockListTools.mockResolvedValue([{ name: 'search_repositories' }]);
        const originalKey = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            const { body } = await api('POST', '/guild/g1/mcp-servers/github/test');
            expect(body.success).toBe(true);
        } finally {
            if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
        }
    });

    test('reports a failed connection instead of a 500', async () => {
        doc = makeDoc([{ ...stored, authorizationToken: 'ghp_bad' }]);
        mockListTools.mockRejectedValue(
            Object.assign(new Error('HTTP 401 — the server rejected the authorization token'), { status: 401 })
        );

        const { status, body } = await api('POST', '/guild/g1/mcp-servers/github/test');

        expect(status).toBe(200);
        expect(body.success).toBe(false);
        expect(body.message).toMatch(/401/);
    });

    test('closes the session whether the test passed or failed', async () => {
        doc = makeDoc([stored]);
        mockListTools.mockRejectedValue(new Error('nope'));
        await api('POST', '/guild/g1/mcp-servers/github/test');
        expect(mockClose).toHaveBeenCalled();
    });
});

// A connection's documents are a separate switch from its tools, and one that
// puts third-party text in the system prompt of every message — so it has to
// survive a save exactly as it was set, and be off when nobody set it.
describe('using a connection\'s documents as knowledge', () => {
    const stored = {
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        authorizationToken: 'ghp_good',
        allowedTools: [],
        blockedTools: [],
        confirmTools: []
    };

    test('round-trips through a save', async () => {
        doc = makeDoc([{ ...stored }]);
        Guild.findOne.mockResolvedValue(doc);

        const { status, body } = await api('PUT', '/guild/g1/mcp-servers/github', {
            url: stored.url,
            resources: true
        });

        expect(status).toBe(200);
        expect(doc.ai.mcpServers[0].resources).toBe(true);
        expect(body.servers[0].resources).toBe(true);
    });

    test('is off when the panel does not send it', async () => {
        doc = makeDoc([{ ...stored, resources: true }]);
        Guild.findOne.mockResolvedValue(doc);

        const { body } = await api('PUT', '/guild/g1/mcp-servers/github', { url: stored.url });
        expect(doc.ai.mcpServers[0].resources).toBe(false);
        expect(body.servers[0].resources).toBe(false);
    });
});

describe('the approval policy', () => {
    const stored = {
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        authorizationToken: 'ghp_good',
        allowedTools: [],
        blockedTools: [],
        confirmTools: []
    };

    test('a per-connection approval list round-trips through a save', async () => {
        doc = makeDoc([{ ...stored }]);
        Guild.findOne.mockResolvedValue(doc);

        const { status, body } = await api('PUT', '/guild/g1/mcp-servers/github', {
            url: stored.url,
            confirmTools: ['create_issue', 'create_issue', 'send_email']
        });

        expect(status).toBe(200);
        // Duplicates collapse, the way the allow and block lists already do.
        expect(doc.ai.mcpServers[0].confirmTools).toEqual(['create_issue', 'send_email']);
        expect(body.servers[0].confirmTools).toEqual(['create_issue', 'send_email']);
    });

    test('is refused when it is not a list of names', async () => {
        doc = makeDoc([{ ...stored }]);
        Guild.findOne.mockResolvedValue(doc);

        const { status, body } = await api('PUT', '/guild/g1/mcp-servers/github', {
            url: stored.url,
            confirmTools: 'create_issue'
        });

        expect(status).toBe(400);
        expect(body.error).toMatch(/confirmTools/);
    });

    test('the list endpoint reports the guild mode and what the modes are', async () => {
        doc = makeDoc([{ ...stored }]);
        doc.ai.mcpConfirm = 'writes';
        Guild.findOne.mockReturnValue({ lean: async () => doc });

        const { body } = await api('GET', '/guild/g1/mcp-servers');

        expect(body.confirmMode).toBe('writes');
        expect(body.confirmModes).toEqual(['off', 'destructive', 'writes', 'always']);
    });

    test('a guild that never set one reports the default, not undefined', async () => {
        doc = makeDoc([{ ...stored }]);
        Guild.findOne.mockReturnValue({ lean: async () => doc });

        expect((await api('GET', '/guild/g1/mcp-servers')).body.confirmMode).toBe('off');
    });

    test('Test says how many of the live tools would need approving', async () => {
        doc = makeDoc([{ ...stored, blockedTools: ['delete_file'] }]);
        doc.ai.mcpConfirm = 'destructive';
        Guild.findOne.mockReturnValue({ lean: async () => doc });
        mockListTools.mockResolvedValue([
            { name: 'search', annotations: { readOnlyHint: true } },
            { name: 'create_issue', annotations: { readOnlyHint: false } },
            { name: 'delete_file', annotations: { readOnlyHint: false } }
        ]);

        const { body } = await api('POST', '/guild/g1/mcp-servers/github/test');

        expect(body.enabledCount).toBe(2);
        // delete_file is blocked, so it is not one of the two that would ask.
        expect(body.confirmCount).toBe(1);
        expect(body.message).toMatch(/1 needing approval/);
        expect(body.toolDetail).toEqual([
            { name: 'search', enabled: true, confirm: false, annotations: { readOnlyHint: true } },
            { name: 'create_issue', enabled: true, confirm: true, annotations: { readOnlyHint: false } },
            { name: 'delete_file', enabled: false, confirm: true, annotations: { readOnlyHint: false } }
        ]);
    });

    test('Test still lists the plain tool names it always did', async () => {
        doc = makeDoc([{ ...stored }]);
        Guild.findOne.mockReturnValue({ lean: async () => doc });
        mockListTools.mockResolvedValue([{ name: 'search' }]);

        expect((await api('POST', '/guild/g1/mcp-servers/github/test')).body.tools).toEqual(['search']);
    });
});

describe('the activity endpoint', () => {
    test('answers the ledger for the default window', async () => {
        mockGetToolUsage.mockResolvedValue([{ server: 'github', calls: 3 }]);

        const { status, body } = await api('GET', '/guild/g1/mcp-servers/usage');

        expect(status).toBe(200);
        expect(mockGetToolUsage).toHaveBeenCalledWith('g1', 7);
        expect(body).toEqual({ days: 7, servers: [{ server: 'github', calls: 3 }] });
    });

    test('takes a window from the query string', async () => {
        await api('GET', '/guild/g1/mcp-servers/usage?days=30');
        expect(mockGetToolUsage).toHaveBeenCalledWith('g1', 30);
    });

    test('clamps a window somebody typed by hand', async () => {
        await api('GET', '/guild/g1/mcp-servers/usage?days=9999');
        expect(mockGetToolUsage).toHaveBeenCalledWith('g1', 90);

        await api('GET', '/guild/g1/mcp-servers/usage?days=0');
        expect(mockGetToolUsage).toHaveBeenLastCalledWith('g1', 1);
    });

    test('falls back to the default for a window that is not a number', async () => {
        await api('GET', '/guild/g1/mcp-servers/usage?days=lots');
        expect(mockGetToolUsage).toHaveBeenCalledWith('g1', 7);
    });

    test('is not mistaken for a connection named "usage"', async () => {
        // GET /mcp-servers/usage sits beside DELETE /mcp-servers/:name, so this
        // is the route ordering staying honest.
        mockGetToolUsage.mockResolvedValue([]);
        expect((await api('GET', '/guild/g1/mcp-servers/usage')).status).toBe(200);
    });
});

describe('the route the panel is told about', () => {
    const stored = {
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        allowedTools: [],
        blockedTools: [],
        confirmTools: []
    };

    const listWith = async ai => {
        doc = makeDoc([{ ...stored }]);
        Object.assign(doc.ai, ai);
        Guild.findOne.mockReturnValue({ lean: async () => doc });
        return (await api('GET', '/guild/g1/mcp-servers')).body;
    };

    test('reports the setting and what the modes are', async () => {
        const body = await listWith({ mcpRoute: 'client' });
        expect(body.mcpRoute).toBe('client');
        expect(body.mcpRoutes).toEqual(['auto', 'connector', 'client']);
    });

    test('defaults to auto rather than to undefined', async () => {
        expect((await listWith({})).mcpRoute).toBe('auto');
    });

    test('says what auto currently resolves to, since auto is a question', async () => {
        expect((await listWith({})).effectiveRoute).toBe('connector');
        expect((await listWith({ mcpConfirm: 'writes' })).effectiveRoute).toBe('client');
    });

    test('resolves auto to the client when a connection names tools to confirm', async () => {
        doc = makeDoc([{ ...stored, confirmTools: ['create_issue'] }]);
        Guild.findOne.mockReturnValue({ lean: async () => doc });
        expect((await api('GET', '/guild/g1/mcp-servers')).body.effectiveRoute).toBe('client');
    });

    test('an explicit choice is reported as itself, not re-derived', async () => {
        expect((await listWith({ mcpRoute: 'connector', mcpConfirm: 'always' })).effectiveRoute).toBe('connector');
    });
});
