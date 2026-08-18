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
jest.mock('@anthropic-ai/sdk', () => {
    const betaCreate = jest.fn();
    class MockAnthropic {
        constructor() { this.beta = { messages: { create: betaCreate } }; }
    }
    MockAnthropic.__betaCreate = betaCreate;
    return MockAnthropic;
});

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
    test('needs an Anthropic key before it can try', async () => {
        doc = makeDoc([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true, allowedTools: [], blockedTools: [] }]);
        const originalKey = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            const { status, body } = await api('POST', '/guild/g1/mcp-servers/github/test');
            expect(status).toBe(400);
            expect(body.error).toMatch(/Anthropic API key/);
        } finally {
            if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
        }
    });

    test('404s for a server that was never added', async () => {
        const { status } = await api('POST', '/guild/g1/mcp-servers/ghost/test');
        expect(status).toBe(404);
    });

    test('reports a failed connection instead of a 500', async () => {
        doc = makeDoc([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true, authorizationToken: 'ghp_bad', allowedTools: [], blockedTools: [] }]);
        const originalKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
        const betaCreate = require('@anthropic-ai/sdk').__betaCreate;
        betaCreate.mockRejectedValue(Object.assign(new Error('mcp server returned 401'), { status: 400 }));
        try {
            const { status, body } = await api('POST', '/guild/g1/mcp-servers/github/test');
            expect(status).toBe(200);
            expect(body.success).toBe(false);
            expect(body.message).toMatch(/401/);
        } finally {
            if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = originalKey;
        }
    });

    test('sends the stored server and the beta flag on a successful test', async () => {
        doc = makeDoc([{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true, authorizationToken: 'ghp_good', allowedTools: [], blockedTools: ['delete_file'] }]);
        const originalKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
        const betaCreate = require('@anthropic-ai/sdk').__betaCreate;
        betaCreate.mockResolvedValue({ content: [], stop_reason: 'max_tokens' });
        try {
            const { status, body } = await api('POST', '/guild/g1/mcp-servers/github/test');
            expect(status).toBe(200);
            expect(body.success).toBe(true);

            const sent = betaCreate.mock.calls[0][0];
            expect(sent.betas).toEqual(['mcp-client-2025-11-20']);
            expect(sent.mcp_servers).toEqual([
                { type: 'url', url: 'https://api.githubcopilot.com/mcp/', name: 'github', authorization_token: 'ghp_good' }
            ]);
            expect(sent.tools).toEqual([
                { type: 'mcp_toolset', mcp_server_name: 'github', configs: { delete_file: { enabled: false } } }
            ]);
            // One token is enough: the connection and tool listing happen before
            // any generation, so this stays cheap.
            expect(sent.max_tokens).toBe(1);
        } finally {
            if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = originalKey;
        }
    });
});
