'use strict';

// One inspection, two callers: the dashboard's Test button and `/ai mcp test`.
// They have to give the same answer, because an admin who tests from the panel
// and then checks from a channel believes they are checking the same thing.
//
// A failed connection is the expected outcome of a test, not a fault, so it
// comes back as a result with what the server said in it rather than as an
// exception either caller would have to remember to catch.

const mockListTools = jest.fn();
const mockListResources = jest.fn(async () => []);
const mockListPrompts = jest.fn(async () => []);
const mockClose = jest.fn(async () => {});
const mockConstructed = [];

jest.mock('../src/services/ai/mcp/client', () => ({
    McpHttpClient: class {
        constructor(options) {
            mockConstructed.push(options);
            this.serverInfo = { name: 'GitHub MCP Server' };
            this.listTools = mockListTools;
            this.listResources = mockListResources;
            this.listPrompts = mockListPrompts;
            this.close = mockClose;
        }
    }
}));

const { inspectServer, MAX_TOOLS_REPORTED } = require('../src/services/ai/mcp/inspect');
const { entryFor, cachedList, resetMcpCache } = require('../src/services/ai/mcp/connections');
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
    resetMcpCache();
    mockConstructed.length = 0;
    mockListResources.mockResolvedValue([]);
    mockListPrompts.mockResolvedValue([]);
    mockListTools.mockResolvedValue([
        { name: 'search', annotations: { readOnlyHint: true } },
        { name: 'create_issue', annotations: { readOnlyHint: false } },
        { name: 'delete_file', annotations: { readOnlyHint: false } }
    ]);
});

describe('what a test leaves behind', () => {
    test('the lists it fetched are handed to the pool the chat path reads', async () => {
        // A test is a full discovery run — handshake, tools/list, and the two
        // other lists — whose answer was being thrown away, so an admin who
        // saved a server and then used it in a channel paid for it twice.
        mockListResources.mockResolvedValue([{ uri: 'file:///readme.md' }]);
        mockListPrompts.mockResolvedValue([{ name: 'summarize' }]);

        const server = resolve();
        await inspectServer(server);

        const entry = entryFor(server);
        const never = jest.fn();
        await expect(cachedList(entry, server, 'tools', never)).resolves.toHaveLength(3);
        await expect(cachedList(entry, server, 'resources', never)).resolves.toEqual([{ uri: 'file:///readme.md' }]);
        await expect(cachedList(entry, server, 'prompts', never)).resolves.toEqual([{ name: 'summarize' }]);
        expect(never).not.toHaveBeenCalled();
    });

    test('a list the server refused is reported empty but never cached', async () => {
        // "Refused resources/list" and "has no resources" look the same in the
        // report and are not the same thing at all. Caching the first as the
        // second would have the chat path believe for five minutes that this
        // server publishes no documents.
        mockListResources.mockRejectedValue(new Error('HTTP 500'));
        mockListPrompts.mockResolvedValue([{ name: 'summarize' }]);

        const server = resolve();
        const report = await inspectServer(server);

        expect(report.success).toBe(true);
        expect(report.resourceCount).toBe(0);

        const entry = entryFor(server);
        const list = jest.fn(async () => [{ uri: 'file:///readme.md' }]);
        await expect(cachedList(entry, server, 'resources', list)).resolves.toHaveLength(1);
        expect(list).toHaveBeenCalled();

        // The list that did answer is still cached.
        const never = jest.fn();
        await expect(cachedList(entry, server, 'prompts', never)).resolves.toEqual([{ name: 'summarize' }]);
        expect(never).not.toHaveBeenCalled();
    });

    test('a failed test caches nothing — there was nothing to cache', async () => {
        mockListTools.mockRejectedValue(new Error('HTTP 401'));

        const server = resolve();
        expect((await inspectServer(server)).success).toBe(false);

        const list = jest.fn(async () => [{ name: 'search' }]);
        await expect(cachedList(entryFor(server), server, 'tools', list)).resolves.toEqual([{ name: 'search' }]);
        expect(list).toHaveBeenCalled();
    });
});

describe('a connection that answers', () => {
    test('dials exactly what a chat request would', async () => {
        await inspectServer(resolve());
        expect(mockConstructed).toEqual([{
            url: 'https://api.githubcopilot.com/mcp/',
            authorizationToken: 'ghp_x',
            label: 'github',
            getAccessToken: null,
            // A one-off probe belongs to no pooled entry, so there is no
            // cached list for a `list_changed` to invalidate, no channel to put
            // a question to, and no guild whose budget a completion could be
            // billed to (#838).
            onNotification: null,
            elicitation: false,
            sampling: false
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
