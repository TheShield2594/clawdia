'use strict';

// The MCP server list is operator-supplied JSON that turns into request
// parameters Claude connects out with, so every case below is either a shape
// the API would reject or a way a token could leak into the wrong place.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    MCP_BETA_HEADER,
    loadMcpServers,
    getMcpServers,
    buildAnthropicMcpParams
} = require('../src/config/mcpServers');

let tmpDir;
const originalEnv = process.env.MCP_SERVERS_CONFIG;

function writeConfig(contents) {
    const file = path.join(tmpDir, `mcp-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    process.env.MCP_SERVERS_CONFIG = file;
    return file;
}

function load() {
    return loadMcpServers({ reload: true });
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-mcp-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    // Warnings are the module's error channel; assert on them, don't print them.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.MCP_SERVERS_CONFIG;
    else process.env.MCP_SERVERS_CONFIG = originalEnv;
});

describe('loadMcpServers', () => {
    test('a missing file leaves the connector off without complaining', () => {
        process.env.MCP_SERVERS_CONFIG = path.join(tmpDir, 'does-not-exist.json');
        const result = load();
        expect(result.servers).toEqual([]);
        // Explicitly pointing at a file that isn't there is worth one warning.
        expect(result.warnings).toHaveLength(1);
    });

    test('builds both halves of the request from one entry', () => {
        writeConfig({ servers: [{ name: 'example-mcp', url: 'https://mcp.example.com/sse' }] });
        const { servers, warnings } = load();
        expect(warnings).toEqual([]);
        expect(servers).toHaveLength(1);
        expect(servers[0].server).toEqual({ type: 'url', url: 'https://mcp.example.com/sse', name: 'example-mcp' });
        expect(servers[0].toolset).toEqual({ type: 'mcp_toolset', mcp_server_name: 'example-mcp' });
    });

    test('accepts a bare array as well as { servers: [...] }', () => {
        writeConfig([{ name: 'bare', url: 'https://mcp.example.com/sse' }]);
        expect(load().servers.map(s => s.name)).toEqual(['bare']);
    });

    test('keeps every configured server, in file order', () => {
        writeConfig({
            servers: [
                { name: 'one', url: 'https://one.example.com/sse' },
                { name: 'two', url: 'https://two.example.com/sse' },
                { name: 'three', url: 'https://three.example.com/sse' }
            ]
        });
        expect(load().servers.map(s => s.name)).toEqual(['one', 'two', 'three']);
    });

    test('skips servers turned off with enabled: false', () => {
        writeConfig({
            servers: [
                { name: 'on', url: 'https://on.example.com/sse' },
                { name: 'off', url: 'https://off.example.com/sse', enabled: false }
            ]
        });
        const { servers, warnings } = load();
        expect(servers.map(s => s.name)).toEqual(['on']);
        expect(warnings).toEqual([]);
    });

    test('resolves ${VAR} tokens from the environment', () => {
        process.env.TEST_MCP_TOKEN = 'secret-token';
        try {
            writeConfig({
                servers: [{ name: 'authed', url: 'https://mcp.example.com/sse', authorization_token: '${TEST_MCP_TOKEN}' }]
            });
            expect(load().servers[0].server.authorization_token).toBe('secret-token');
        } finally {
            delete process.env.TEST_MCP_TOKEN;
        }
    });

    test('drops a server whose token variable is unset rather than sending the literal', () => {
        delete process.env.MISSING_MCP_TOKEN;
        writeConfig({
            servers: [{ name: 'authed', url: 'https://mcp.example.com/sse', authorization_token: '${MISSING_MCP_TOKEN}' }]
        });
        const { servers, warnings } = load();
        expect(servers).toEqual([]);
        expect(warnings[0]).toMatch(/MISSING_MCP_TOKEN/);
    });

    test('rejects non-https URLs', () => {
        writeConfig({ servers: [{ name: 'plaintext', url: 'http://mcp.example.com/sse' }] });
        const { servers, warnings } = load();
        expect(servers).toEqual([]);
        expect(warnings[0]).toMatch(/https/);
    });

    test.each([
        ['no name', { url: 'https://mcp.example.com/sse' }],
        ['a name with spaces', { name: 'my server', url: 'https://mcp.example.com/sse' }],
        ['no url', { name: 'nourl' }],
        ['an unparseable url', { name: 'bad', url: 'not-a-url' }],
        ['a non-object entry', 'just-a-string']
    ])('skips an entry with %s', (_label, entry) => {
        writeConfig({ servers: [entry] });
        const { servers, warnings } = load();
        expect(servers).toEqual([]);
        expect(warnings).toHaveLength(1);
    });

    test('skips a duplicate name — the API allows one toolset per server', () => {
        writeConfig({
            servers: [
                { name: 'dupe', url: 'https://one.example.com/sse' },
                { name: 'dupe', url: 'https://two.example.com/sse' }
            ]
        });
        const { servers, warnings } = load();
        expect(servers).toHaveLength(1);
        expect(servers[0].server.url).toBe('https://one.example.com/sse');
        expect(warnings[0]).toMatch(/dupe/);
    });

    test('carries allowlist configuration onto the toolset', () => {
        writeConfig({
            servers: [{
                name: 'calendar',
                url: 'https://mcp.example.com/sse',
                default_config: { enabled: false, defer_loading: true },
                configs: { search_events: { enabled: true }, list_events: { defer_loading: false } }
            }]
        });
        expect(load().servers[0].toolset).toEqual({
            type: 'mcp_toolset',
            mcp_server_name: 'calendar',
            default_config: { enabled: false, defer_loading: true },
            configs: { search_events: { enabled: true }, list_events: { defer_loading: false } }
        });
    });

    test('drops unrecognised tool settings instead of forwarding them', () => {
        writeConfig({
            servers: [{
                name: 'noisy',
                url: 'https://mcp.example.com/sse',
                default_config: { enabled: true, whatever: 'nope' },
                configs: { a_tool: { enabled: 'yes' } }
            }]
        });
        const { servers, warnings } = load();
        expect(servers[0].toolset.default_config).toEqual({ enabled: true });
        expect(servers[0].toolset.configs).toBeUndefined();
        expect(warnings[0]).toMatch(/a_tool/);
    });

    test('invalid JSON disables the connector instead of throwing', () => {
        writeConfig('{ not json');
        const { servers, warnings } = load();
        expect(servers).toEqual([]);
        expect(warnings[0]).toMatch(/valid JSON/);
    });

    test('a top level that is neither array nor { servers } is reported', () => {
        writeConfig({ mcpServers: { foo: {} } });
        const { servers, warnings } = load();
        expect(servers).toEqual([]);
        expect(warnings[0]).toMatch(/array of servers/);
    });

    test('memoizes until asked to reload', () => {
        const file = writeConfig({ servers: [{ name: 'first', url: 'https://one.example.com/sse' }] });
        expect(load().servers.map(s => s.name)).toEqual(['first']);

        fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'second', url: 'https://two.example.com/sse' }] }));
        expect(getMcpServers().map(s => s.name)).toEqual(['first']);
        expect(loadMcpServers({ reload: true }).servers.map(s => s.name)).toEqual(['second']);
    });
});

describe('buildAnthropicMcpParams', () => {
    test('returns null when nothing is configured, so requests stay unchanged', () => {
        writeConfig({ servers: [] });
        load();
        expect(buildAnthropicMcpParams()).toBeNull();
    });

    test('pairs every server with exactly one toolset', () => {
        writeConfig({
            servers: [
                { name: 'one', url: 'https://one.example.com/sse' },
                { name: 'two', url: 'https://two.example.com/sse' }
            ]
        });
        load();
        const params = buildAnthropicMcpParams();
        expect(params.mcp_servers.map(s => s.name)).toEqual(['one', 'two']);
        expect(params.tools.map(t => t.mcp_server_name)).toEqual(['one', 'two']);
        expect(params.tools.every(t => t.type === 'mcp_toolset')).toBe(true);
    });
});

describe('beta flag', () => {
    test('is the current MCP connector version', () => {
        expect(MCP_BETA_HEADER).toBe('mcp-client-2025-11-20');
    });
});
