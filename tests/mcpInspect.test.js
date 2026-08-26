'use strict';

// One inspection, two callers: the dashboard's Test button and `/ai mcp test`.
// They have to give the same answer, because an admin who tests from the panel
// and then checks from a channel believes they are checking the same thing.
//
// A failed connection is the expected outcome of a test, not a fault, so it
// comes back as a result with what the server said in it rather than as an
// exception either caller would have to remember to catch.

const mockListTools = jest.fn();
const mockClose = jest.fn(async () => {});
const mockConstructed = [];

jest.mock('../src/services/ai/mcp/client', () => ({
    McpHttpClient: class {
        constructor(options) {
            mockConstructed.push(options);
            this.serverInfo = { name: 'GitHub MCP Server' };
            this.listTools = mockListTools;
            this.close = mockClose;
        }
    }
}));

const { inspectServer, MAX_TOOLS_REPORTED } = require('../src/services/ai/mcp/inspect');
const { resolveMcpServers } = require('../src/config/mcpServers');

const resolve = over => resolveMcpServers([{
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    enabled: true,
    authorizationToken: 'ghp_x',
    ...over
}])[0];

beforeEach(() => {
    jest.clearAllMocks();
    mockConstructed.length = 0;
    mockListTools.mockResolvedValue([
        { name: 'search', annotations: { readOnlyHint: true } },
        { name: 'create_issue', annotations: { readOnlyHint: false } },
        { name: 'delete_file', annotations: { readOnlyHint: false } }
    ]);
});

describe('a connection that answers', () => {
    test('dials exactly what a chat request would', async () => {
        await inspectServer(resolve());
        expect(mockConstructed).toEqual([{
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_x',
            label: 'github'
        }]);
    });

    test('counts what the filters leave live, not what the server offers', async () => {
        const report = await inspectServer(resolve({ blockedTools: ['delete_file'] }));

        expect(report).toMatchObject({ success: true, toolCount: 3, enabledCount: 2 });
        expect(report.message).toContain('GitHub MCP Server');
    });

    test('counts approvals against the live tools only', async () => {
        // A blocked tool cannot be approved into running, so counting it here
        // would tell an admin they had two prompts coming when they had one.
        const report = await inspectServer(
            resolve({ blockedTools: ['delete_file'] }),
            { confirmMode: 'destructive' }
        );

        expect(report.confirmCount).toBe(1);
        expect(report.message).toContain('1 needing approval');
    });

    test('says nothing about approval when the guild asks for none', async () => {
        const report = await inspectServer(resolve());
        expect(report.confirmCount).toBe(0);
        expect(report.message).not.toContain('approval');
    });

    test('describes each tool with what the server said about it', async () => {
        const report = await inspectServer(resolve({ blockedTools: ['delete_file'] }), { confirmMode: 'writes' });

        expect(report.tools).toEqual([
            { name: 'search', enabled: true, confirm: false, annotations: { readOnlyHint: true } },
            { name: 'create_issue', enabled: true, confirm: true, annotations: { readOnlyHint: false } },
            { name: 'delete_file', enabled: false, confirm: true, annotations: { readOnlyHint: false } }
        ]);
    });

    test('closes the session rather than leaving one on the far side', async () => {
        // A test that leaks a session on every click is a slow leak on
        // somebody else's server.
        await inspectServer(resolve());
        expect(mockClose).toHaveBeenCalled();
    });

    test('stops listing at a length a person would still read', async () => {
        mockListTools.mockResolvedValue(
            Array.from({ length: MAX_TOOLS_REPORTED + 10 }, (_, i) => ({ name: `tool_${i}` }))
        );

        const report = await inspectServer(resolve());
        expect(report.tools).toHaveLength(MAX_TOOLS_REPORTED);
        // The count is still the real one, so the message does not lie.
        expect(report.toolCount).toBe(MAX_TOOLS_REPORTED + 10);
    });
});

describe('a connection that does not', () => {
    test('reports what the server said instead of throwing', async () => {
        mockListTools.mockRejectedValue(new Error('HTTP 401 — the server rejected the authorization token'));

        const report = await inspectServer(resolve());
        expect(report).toMatchObject({ success: false, toolCount: 0, enabledCount: 0, tools: [] });
        expect(report.message).toContain('401');
    });

    test('still closes what it opened', async () => {
        mockListTools.mockRejectedValue(new Error('socket hang up'));
        await inspectServer(resolve());
        expect(mockClose).toHaveBeenCalled();
    });

    test('has something to say even for a failure with no message', async () => {
        mockListTools.mockRejectedValue(new Error(''));
        expect((await inspectServer(resolve())).message).toBe('Unknown error');
    });
});
