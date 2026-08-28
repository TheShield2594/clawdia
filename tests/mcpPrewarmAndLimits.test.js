'use strict';

// The four things a single turn's ceilings do not cover: what a message costs
// before it starts, what one server sees at once, what a user costs across
// several messages, and how far a long call has got.
//
// Everything in the toolkit up to now bounds one turn. None of it says
// anything about the first message after a restart paying full discovery, about
// six calls in one round all landing on the same server, or about a user
// sending that message ten times in a row.

const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn(async () => {});

jest.mock('../src/services/ai/mcp/client', () => {
    class McpError extends Error {}
    return {
        McpError,
        MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
        McpHttpClient: class {
            constructor() {
                this.listTools = mockListTools;
                this.callTool = mockCallTool;
                this.close = mockClose;
            }
        }
    };
});

const {
    prepareMcpToolkit,
    prewarmMcpServers,
    resetMcpCache,
    MAX_PARALLEL_PER_SERVER
} = require('../src/services/ai/mcp/toolkit');
const { toolCallBudget, TOOL_CALLS_PER_MESSAGE, SCHEDULED_TOOL_CALLS_PER_HOUR } = require('../src/services/ai/rateLimit');

const GITHUB = { name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true };
const WIKI = { name: 'wiki', url: 'https://wiki.example.com/mcp', enabled: true };
const textResult = text => ({ content: [{ type: 'text', text }], structuredContent: null, isError: false });

function deferred() {
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    return { promise, ...settle };
}

beforeEach(() => {
    jest.clearAllMocks();
    resetMcpCache();
    mockListTools.mockResolvedValue([{ name: 'search' }, { name: 'read' }]);
    mockCallTool.mockResolvedValue(textResult('ok'));
});

describe('warming the tool list before anybody asks for it', () => {
    test('a prewarmed server costs the first message no discovery at all', async () => {
        expect(await prewarmMcpServers([GITHUB])).toBe(1);
        expect(mockListTools).toHaveBeenCalledTimes(1);

        const toolkit = await prepareMcpToolkit([GITHUB]);
        expect(toolkit.definitions.map(d => d.toolName)).toEqual(['search', 'read']);
        // The message found the list already there.
        expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    test('one connection is dialled once however many guilds list it', async () => {
        // The operator's config file belongs to every guild, so warming a
        // hundred of them must not be a hundred handshakes to one server.
        await prewarmMcpServers([GITHUB, { ...GITHUB, name: 'same-again' }]);
        expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    test('a server that is down is skipped, not fatal, and is tried again later', async () => {
        mockListTools.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await prewarmMcpServers([GITHUB, WIKI])).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('prewarm skipped "github"'));
        warn.mockRestore();
    });

    test('nothing configured is nothing to warm', async () => {
        expect(await prewarmMcpServers([])).toBe(0);
        expect(mockListTools).not.toHaveBeenCalled();
    });
});

describe('what one server sees at once', () => {
    test(`a round aimed entirely at one server still queues past ${MAX_PARALLEL_PER_SERVER}`, async () => {
        let running = 0;
        let peak = 0;
        const gates = [];
        mockCallTool.mockImplementation(() => {
            running++;
            peak = Math.max(peak, running);
            const gate = deferred();
            gates.push(gate);
            return gate.promise.then(() => { running--; return textResult('ok'); });
        });

        const toolkit = await prepareMcpToolkit([GITHUB]);
        const calls = Array.from({ length: 6 }, () => toolkit.call('github__search', {}));

        await Promise.resolve();
        expect(peak).toBe(MAX_PARALLEL_PER_SERVER);

        while (gates.length) {
            gates.shift().resolve();
            await new Promise(resolve => setImmediate(resolve));
        }
        await Promise.all(calls);
        expect(peak).toBe(MAX_PARALLEL_PER_SERVER);
        expect(mockCallTool).toHaveBeenCalledTimes(6);
    });

    test('calls to different servers do not queue behind each other', async () => {
        let running = 0;
        let peak = 0;
        const gates = [];
        mockCallTool.mockImplementation(() => {
            running++;
            peak = Math.max(peak, running);
            const gate = deferred();
            gates.push(gate);
            return gate.promise.then(() => { running--; return textResult('ok'); });
        });

        const toolkit = await prepareMcpToolkit([GITHUB, WIKI]);
        const calls = [
            ...Array.from({ length: 3 }, () => toolkit.call('github__search', {})),
            ...Array.from({ length: 3 }, () => toolkit.call('wiki__search', {}))
        ];

        await Promise.resolve();
        // Three each, six together — the per-server cap is not a global one.
        expect(peak).toBe(6);

        while (gates.length) gates.shift().resolve();
        await Promise.all(calls);
    });
});

describe('what a user costs across turns', () => {
    const rateLimit = { perUser: 2, perChannel: 0, windowMin: 10 };

    test('tool calls are counted separately from messages', async () => {
        // A user allowed two messages is not allowed only two tool calls: one
        // question that needs a lot of looking up should not eat the allowance
        // for the next one.
        const budget = toolCallBudget({ guildId: 'g1', userId: 'u1', rateLimit });
        const allowed = rateLimit.perUser * TOOL_CALLS_PER_MESSAGE;

        for (let n = 0; n < allowed; n++) expect(budget()).toBe(true);
        expect(budget()).toBe(false);
    });

    test('it can be asked without being spent', () => {
        // What the toolkit uses to refuse a call before the approval buttons
        // go up without charging for the answer nobody has given yet.
        const budget = toolCallBudget({ guildId: 'g1', userId: 'peek', rateLimit });
        const allowed = rateLimit.perUser * TOOL_CALLS_PER_MESSAGE;

        for (let n = 0; n < allowed * 2; n++) expect(budget.peek()).toBe(true);
        for (let n = 0; n < allowed; n++) expect(budget()).toBe(true);
        expect(budget.peek()).toBe(false);
    });

    test('the window is per guild, so one server does not eat another\'s allowance', () => {
        const here = toolCallBudget({ guildId: 'g1', userId: 'u1', rateLimit });
        const there = toolCallBudget({ guildId: 'g2', userId: 'u1', rateLimit });

        for (let n = 0; n < rateLimit.perUser * TOOL_CALLS_PER_MESSAGE; n++) here();
        expect(here()).toBe(false);
        expect(there()).toBe(true);
    });

    test('a guild that configured no limit is unbounded', () => {
        expect(toolCallBudget({ guildId: 'g1', userId: 'u1', rateLimit: { perUser: 0, windowMin: 10 } })).toBeNull();
        expect(toolCallBudget({ guildId: 'g1', userId: 'u1', rateLimit: null })).toBeNull();
        // Nothing to key a per-guild scheduled budget on either.
        expect(toolCallBudget({ userId: null, rateLimit })).toBeNull();
    });

    test('a call nobody sent is bounded per guild rather than not at all', () => {
        // The scheduled digests and newspapers used to come back null here,
        // which this toolkit reads as unbounded — so the one class of request
        // that runs on a timer with nobody watching was the only one that could
        // fan out without limit (#831).
        const budget = toolCallBudget({ guildId: 'g-scheduled-1', userId: null, rateLimit });
        expect(typeof budget).toBe('function');

        for (let n = 0; n < SCHEDULED_TOOL_CALLS_PER_HOUR; n++) expect(budget()).toBe(true);
        expect(budget()).toBe(false);

        // And per guild, so one server's hourly job cannot spend another's.
        expect(toolCallBudget({ guildId: 'g-scheduled-2', userId: null, rateLimit })()).toBe(true);
    });

    test('a call past the allowance is refused in words the model can answer around', async () => {
        let left = 1;
        const toolkit = await prepareMcpToolkit([GITHUB], { toolBudget: () => left-- > 0 });

        expect(await toolkit.call('github__search', {})).toContain('ok');
        const refused = await toolkit.call('github__search', {});

        expect(refused).toMatch(/tool calls they are allowed/);
        expect(refused).toMatch(/try again shortly/);
        // Refused, not attempted: the point is that the request is never made.
        expect(mockCallTool).toHaveBeenCalledTimes(1);
    });

    test('nobody is asked to approve a call the limit has already refused', async () => {
        const confirmTool = jest.fn(async () => ({ approved: true }));
        // The real budget can be asked without being spent, which is what lets
        // the refusal come before the buttons rather than instead of them.
        const toolBudget = () => false;
        toolBudget.peek = () => false;
        const toolkit = await prepareMcpToolkit([GITHUB], { confirmMode: 'always', confirmTool, toolBudget });

        expect(await toolkit.call('github__search', {})).toMatch(/tool calls they are allowed/);
        expect(confirmTool).not.toHaveBeenCalled();
    });

    // A slot spent on a call nobody agreed to run is an allowance emptied by
    // tools that never ran — the failure a guild with confirm-mode on hits
    // first, and the one it would never think to look for.
    describe('a call somebody has to approve', () => {
        const peekable = spend => {
            const budget = jest.fn(spend);
            budget.peek = jest.fn(() => true);
            return budget;
        };

        const confirming = (decision, toolBudget) => prepareMcpToolkit([GITHUB], {
            confirmMode: 'always',
            confirmTool: async () => decision,
            toolBudget
        });

        test('costs nothing when it is declined', async () => {
            const toolBudget = peekable(() => true);
            const toolkit = await confirming({ approved: false }, toolBudget);

            expect(await toolkit.call('github__search', {})).toMatch(/declined/);
            expect(toolBudget).not.toHaveBeenCalled();
            // Asked, though: a call with no allowance left should not put
            // buttons in front of somebody either way.
            expect(toolBudget.peek).toHaveBeenCalled();
        });

        test('costs nothing when nobody answers', async () => {
            const toolBudget = peekable(() => true);
            const toolkit = await confirming({ approved: false, timedOut: true }, toolBudget);

            expect(await toolkit.call('github__search', {})).toMatch(/in time/);
            expect(toolBudget).not.toHaveBeenCalled();
        });

        test('costs a slot once it runs', async () => {
            const toolBudget = peekable(() => true);
            const toolkit = await confirming({ approved: true }, toolBudget);

            expect(await toolkit.call('github__search', {})).toContain('ok');
            expect(toolBudget).toHaveBeenCalledTimes(1);
        });

        test('is refused if the last slot went while the buttons were up', async () => {
            // A peek is not a reservation: the calls of one round run together,
            // and the spend is what decides.
            const toolBudget = peekable(() => false);
            const toolkit = await confirming({ approved: true }, toolBudget);

            expect(await toolkit.call('github__search', {})).toMatch(/tool calls they are allowed/);
            expect(mockCallTool).not.toHaveBeenCalled();
        });
    });

    test('a toolkit built without a budget is unbounded, as the unattributed callers were', async () => {
        const toolkit = await prepareMcpToolkit([GITHUB]);
        for (let n = 0; n < 20; n++) expect(await toolkit.call('github__search', {})).toContain('ok');
    });
});

describe('a long call saying how far it has got', () => {
    test('progress from the server reaches the listener watching the reply', async () => {
        mockCallTool.mockImplementation(async (_name, _args, { onProgress }) => {
            onProgress({ progress: 4, total: 10, message: 'indexing' });
            onProgress({ progress: 9, total: 10, message: null });
            return textResult('ok');
        });

        const events = [];
        const toolkit = await prepareMcpToolkit([GITHUB], { onToolEvent: event => events.push(event) });
        await toolkit.call('github__search', {});

        expect(events.filter(e => e.type === 'progress')).toEqual([
            expect.objectContaining({ server: 'github', tool: 'search', progress: 4, total: 10, message: 'indexing' }),
            expect.objectContaining({ progress: 9, total: 10, message: null })
        ]);
    });

    test('progress carries the call id, so two calls to one tool stay apart', async () => {
        mockCallTool.mockImplementation(async (_name, args, { onProgress }) => {
            onProgress({ progress: args.n, total: 10, message: null });
            return textResult('ok');
        });

        const events = [];
        const toolkit = await prepareMcpToolkit([GITHUB], { onToolEvent: event => events.push(event) });
        await Promise.all([toolkit.call('github__search', { n: 1 }), toolkit.call('github__search', { n: 2 })]);

        const progress = events.filter(e => e.type === 'progress');
        expect(new Set(progress.map(e => e.id)).size).toBe(2);
    });
});
