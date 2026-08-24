'use strict';

// The provider-neutral toolkit: what a guild's MCP servers look like by the time
// a non-Anthropic provider sees them. The rules that matter here are the ones a
// provider must not have to think about — one unambiguous name per tool, the
// guild's allow and block lists applied, a broken server skipped rather than
// fatal, and a tool result that is always a string.

// Prefixed with `mock` so jest allows the factory below to reach them.
const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn(async () => {});
const mockConstructed = [];

jest.mock('../src/services/ai/mcp/client', () => {
    class McpError extends Error {
        constructor(message, { sessionExpired = false } = {}) {
            super(message);
            this.sessionExpired = sessionExpired;
        }
    }
    return {
        McpError,
        McpHttpClient: class {
            constructor(options) {
                mockConstructed.push(options);
                this.listTools = mockListTools;
                this.callTool = mockCallTool;
                this.close = mockClose;
            }
        }
    };
});

const { McpError } = require('../src/services/ai/mcp/client');
const {
    prepareMcpToolkit,
    toolkitFor,
    resetMcpCache,
    MAX_TOOL_RESULT_CHARS
} = require('../src/services/ai/mcp/toolkit');

const GITHUB = {
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    authorizationToken: 'ghp_x',
    enabled: true,
    allowedTools: [],
    blockedTools: []
};

const TOOLS = [
    { name: 'search_repositories', description: 'Search repositories', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'delete_file', description: 'Delete a file' }
];

function textResult(text) {
    return { content: [{ type: 'text', text }], structuredContent: null, isError: false };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockConstructed.length = 0;
    resetMcpCache();
    mockListTools.mockResolvedValue(TOOLS);
    mockCallTool.mockResolvedValue(textResult('ok'));
});

describe('discovery', () => {
    test('names every tool for the server it came from', async () => {
        const toolkit = await prepareMcpToolkit([GITHUB]);

        expect(toolkit.definitions.map(d => d.name))
            .toEqual(['github__search_repositories', 'github__delete_file']);
        expect(toolkit.definitions[0]).toMatchObject({
            serverName: 'github',
            toolName: 'search_repositories',
            description: 'Search repositories',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
        });
    });

    test('connects with the stored url and token', async () => {
        await prepareMcpToolkit([GITHUB]);
        expect(mockConstructed).toEqual([{
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_x',
            label: 'github'
        }]);
    });

    test('gives a tool with no schema an empty object schema, not nothing', async () => {
        // A provider that is handed `parameters: undefined` rejects the request.
        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(toolkit.definitions[1].inputSchema).toEqual({ type: 'object', properties: {} });
    });

    test('returns null when the guild has no servers', async () => {
        expect(await prepareMcpToolkit([])).toBeNull();
    });

    test('returns null rather than an empty toolkit when a server cannot be reached', async () => {
        mockListTools.mockRejectedValue(new Error('HTTP 401'));
        expect(await prepareMcpToolkit([GITHUB])).toBeNull();
    });

    test('skips the server that is down and keeps the one that is up', async () => {
        mockListTools
            .mockRejectedValueOnce(new Error('HTTP 500'))
            .mockResolvedValueOnce([{ name: 'ask' }]);

        const toolkit = await prepareMcpToolkit([
            { ...GITHUB, name: 'broken', url: 'https://broken.example.com/mcp' },
            { ...GITHUB, name: 'wiki', url: 'https://wiki.example.com/mcp' }
        ]);

        expect(toolkit.servers).toEqual(['wiki']);
        expect(toolkit.definitions.map(d => d.name)).toEqual(['wiki__ask']);
    });

    test('keeps names unique when two servers offer the same tool', async () => {
        mockListTools.mockResolvedValue([{ name: 'search' }]);
        const toolkit = await prepareMcpToolkit([
            { ...GITHUB, name: 'a', url: 'https://a.example.com/mcp' },
            { ...GITHUB, name: 'a', url: 'https://b.example.com/mcp' }
        ]);
        // Same name twice is one server after the merge, so the real collision
        // case is a long name that truncates onto another.
        expect(new Set(toolkit.definitions.map(d => d.name)).size).toBe(toolkit.definitions.length);
    });

    test('trims a name too long for a provider to accept', async () => {
        mockListTools.mockResolvedValue([
            { name: `${'x'.repeat(80)}_one` },
            { name: `${'x'.repeat(80)}_two` }
        ]);

        const toolkit = await prepareMcpToolkit([GITHUB]);
        const names = toolkit.definitions.map(d => d.name);

        expect(names.every(n => n.length <= 64 && /^[A-Za-z0-9_-]+$/.test(n))).toBe(true);
        expect(new Set(names).size).toBe(2);
    });
});

describe('tool filters', () => {
    test('a blocked tool is never offered', async () => {
        const toolkit = await prepareMcpToolkit([{ ...GITHUB, blockedTools: ['delete_file'] }]);
        expect(toolkit.definitions.map(d => d.toolName)).toEqual(['search_repositories']);
    });

    test('an allow list turns everything else off', async () => {
        const toolkit = await prepareMcpToolkit([{ ...GITHUB, allowedTools: ['delete_file'] }]);
        expect(toolkit.definitions.map(d => d.toolName)).toEqual(['delete_file']);
    });

    test('blocking wins over allowing', async () => {
        const toolkit = await prepareMcpToolkit([{
            ...GITHUB,
            allowedTools: ['delete_file', 'search_repositories'],
            blockedTools: ['delete_file']
        }]);
        expect(toolkit.definitions.map(d => d.toolName)).toEqual(['search_repositories']);
    });

    test('a server whose every tool is filtered out offers nothing at all', async () => {
        const toolkit = await prepareMcpToolkit([{
            ...GITHUB,
            blockedTools: ['search_repositories', 'delete_file']
        }]);
        expect(toolkit).toBeNull();
    });
});

describe('calling a tool', () => {
    test('routes the call to the right server tool under its real name', async () => {
        const toolkit = await prepareMcpToolkit([GITHUB]);
        const text = await toolkit.call('github__search_repositories', { q: 'clawdia' });

        expect(mockCallTool).toHaveBeenCalledWith('search_repositories', { q: 'clawdia' });
        expect(text).toBe('ok');
    });

    test('joins several text blocks and marks the ones it cannot pass on', async () => {
        mockCallTool.mockResolvedValue({
            content: [{ type: 'text', text: 'first' }, { type: 'image', data: 'AAAA' }, { type: 'text', text: 'second' }],
            structuredContent: null,
            isError: false
        });

        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(await toolkit.call('github__search_repositories', {}))
            .toBe('first\n[image content omitted]\nsecond');
    });

    test('falls back to structured output when there is no text block', async () => {
        mockCallTool.mockResolvedValue({ content: [], structuredContent: { stars: 12 }, isError: false });
        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(await toolkit.call('github__search_repositories', {})).toBe('{"stars":12}');
    });

    test('labels a tool-level error instead of passing it off as a result', async () => {
        mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'no such repo' }], isError: true });
        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(await toolkit.call('github__search_repositories', {}))
            .toBe('The tool reported an error: no such repo');
    });

    test('truncates a result too large to be worth sending to a model', async () => {
        mockCallTool.mockResolvedValue(textResult('y'.repeat(MAX_TOOL_RESULT_CHARS * 2)));
        const toolkit = await prepareMcpToolkit([GITHUB]);
        const text = await toolkit.call('github__search_repositories', {});

        expect(text.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200);
        expect(text).toMatch(/truncated/);
    });

    // A failed call has to come back as something the model can read: losing the
    // whole reply because one tool 500'd is worse than telling it what happened.
    test('reports a transport failure as text rather than throwing', async () => {
        mockCallTool.mockRejectedValue(new Error('socket hang up'));
        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(await toolkit.call('github__search_repositories', {}))
            .toMatch(/could not be run: socket hang up/);
    });

    test('answers a name the model invented instead of throwing', async () => {
        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(await toolkit.call('nonexistent_tool', {})).toMatch(/No tool named/);
    });

    test('reconnects once when the session has expired underneath it', async () => {
        mockCallTool
            .mockRejectedValueOnce(new McpError('HTTP 404', { sessionExpired: true }))
            .mockResolvedValueOnce(textResult('second time lucky'));

        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(await toolkit.call('github__search_repositories', {})).toBe('second time lucky');
        expect(mockCallTool).toHaveBeenCalledTimes(2);
    });
});

describe('caching', () => {
    test('lists a server\'s tools once, not once per message', async () => {
        await prepareMcpToolkit([GITHUB]);
        await prepareMcpToolkit([GITHUB]);
        expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    test('two messages arriving together share one handshake', async () => {
        let release;
        mockListTools.mockReturnValue(new Promise(resolve => { release = () => resolve(TOOLS); }));

        const both = Promise.all([prepareMcpToolkit([GITHUB]), prepareMcpToolkit([GITHUB])]);
        release();
        await both;

        expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    test('does not hammer a server that just failed', async () => {
        mockListTools.mockRejectedValue(new Error('HTTP 500'));
        await prepareMcpToolkit([GITHUB]);
        await prepareMcpToolkit([GITHUB]);
        expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    test('a different token is a different connection', async () => {
        await prepareMcpToolkit([GITHUB]);
        await prepareMcpToolkit([{ ...GITHUB, authorizationToken: 'ghp_rotated' }]);
        expect(mockListTools).toHaveBeenCalledTimes(2);
    });
});

describe('toolkitFor', () => {
    test('offers nothing when the caller switched MCP off', async () => {
        expect(await toolkitFor({ useMcp: false, mcpServers: [GITHUB] })).toBeNull();
        expect(mockListTools).not.toHaveBeenCalled();
    });

    test('offers the tools when the caller did not', async () => {
        const toolkit = await toolkitFor({ mcpServers: [GITHUB] });
        expect(toolkit.definitions).toHaveLength(2);
    });

    test('swallows a discovery failure rather than costing the user their answer', async () => {
        mockListTools.mockImplementation(() => { throw new Error('boom'); });
        expect(await toolkitFor({ mcpServers: [GITHUB] })).toBeNull();
    });
});
