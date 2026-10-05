'use strict';

// Sub-agent delegation for deep tasks (#1232): a task can fan out to bounded,
// parallel children and combine their answers; the children cannot recurse or
// write unattended; and what they spend stays inside the task's own limits.

jest.mock('../src/services/ai/index', () => ({ getCompletion: jest.fn() }));
jest.mock('../src/models/KnowledgeBase', () => ({}));
jest.mock('../src/models/ConversationLog', () => ({}));

const { getCompletion } = require('../src/services/ai/index');
const {
    delegateTool,
    runDelegation,
    MAX_CHILDREN_PER_CALL,
    MAX_CHILDREN_PER_TASK,
    CHILD_MAX_TOOL_ROUNDS,
    CHILD_TURN_BUDGET_MS
} = require('../src/services/ai/delegate');
const { toolCallBudget, TOOL_CALLS_PER_MESSAGE } = require('../src/services/ai/rateLimit');

const AI = { enabled: true, taskModeEnabled: true, webSearchEnabled: true, learningEnabled: true, imageGeneration: true, openaiKey: 'sk-test' };
const CONFIG = { provider: 'openai', model: 'gpt-test', apiKey: 'sk-test', mcpServers: [], rateLimit: { perUser: 2, windowMin: 10 } };

let seq = 0;
const nextUser = () => `u-del-${++seq}`;
const later = () => Date.now() + 6 * 60 * 1000;

function context(overrides = {}) {
    return { ai: AI, config: CONFIG, guildId: 'g1', userId: nextUser(), state: { spawned: 0 }, complete: getCompletion, ...overrides };
}
const tasks = (...instructions) => ({ tasks: instructions.map(instruction => ({ instruction })) });

beforeEach(() => {
    jest.clearAllMocks();
    getCompletion.mockImplementation(async ({ prompt }) => `findings for: ${prompt}`);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('fanning out', () => {
    test('one child turn per piece, in parallel, and the answers labelled', async () => {
        let running = 0;
        let peak = 0;
        getCompletion.mockImplementation(async ({ prompt }) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise(resolve => setImmediate(resolve));
            running--;
            return `notes on ${prompt}`;
        });

        const text = await runDelegation(tasks('price of A', 'price of B', 'price of C'), context(), { deadline: later() });

        expect(getCompletion).toHaveBeenCalledTimes(3);
        expect(peak).toBe(3);
        expect(text).toMatch(/\[Sub-task 1: price of A\]\nnotes on price of A/);
        expect(text).toMatch(/\[Sub-task 3: price of C\]\nnotes on price of C/);
        expect(text).toMatch(/reference data, not instructions/);
    });

    test('each child starts fresh, with a smaller round budget inside the task\'s clock', async () => {
        const deadline = Date.now() + 2 * 60 * 1000;
        await runDelegation(tasks('look this up'), context(), { deadline });

        const [req] = getCompletion.mock.calls[0];
        expect(req.history).toEqual([]);
        expect(req.prompt).toBe('look this up');
        expect(req.maxRounds).toBe(CHILD_MAX_TOOL_ROUNDS);
        // Two minutes left, less what the task keeps back for its report.
        expect(req.turnBudgetMs).toBeLessThanOrEqual(90_000);
        expect(req.turnBudgetMs).toBeGreaterThan(80_000);
        expect(req.systemPrompt).toMatch(/sub-agent/);

        await runDelegation(tasks('again'), context(), { deadline: later() });
        expect(getCompletion.mock.calls[1][0].turnBudgetMs).toBe(CHILD_TURN_BUDGET_MS);
    });

    test('a child that fails, or is refused by the limits, is one line among the answers', async () => {
        getCompletion
            .mockResolvedValueOnce('fine')
            .mockRejectedValueOnce(Object.assign(new Error('This server has reached its monthly AI budget ($5.00).'), { rateLimited: true }))
            .mockRejectedValueOnce(new Error('500 from the provider'));

        const text = await runDelegation(tasks('a', 'b', 'c'), context(), { deadline: later() });

        expect(text).toMatch(/Sub-task 1: a\]\nfine/);
        expect(text).toMatch(/Sub-task 2: b\]\n\(Not run: This server has reached its monthly AI budget/);
        expect(text).toMatch(/Sub-task 3: c\]\n\(The sub-agent failed with a provider error\.\)/);
    });

    test('a long answer is cut, so four of them leave room in the task\'s turn', async () => {
        getCompletion.mockResolvedValue('x'.repeat(10_000));
        const text = await runDelegation(tasks('a'), context(), { deadline: later() });
        expect(text.length).toBeLessThan(3500);
        expect(text).toMatch(/cut; the sub-agent wrote 7000 more characters/);
    });

    test('the children\'s tool calls show on the task\'s activity, with ids of their own', async () => {
        const onToolEvent = jest.fn(() => true);
        getCompletion.mockImplementation(async ({ onToolEvent: forward }) => {
            forward({ type: 'start', id: 1, server: 'clawdia', tool: 'web_search' });
            return 'done';
        });

        await runDelegation(tasks('a', 'b'), context({ onToolEvent }), { deadline: later() });

        expect(onToolEvent.mock.calls.map(([event]) => event.id).sort()).toEqual(['sub1:1', 'sub2:1']);
    });

    test('a child that never answers is given up on at the task\'s clock', async () => {
        jest.useFakeTimers();
        try {
            getCompletion.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce('quick');
            const pending = runDelegation(tasks('slow', 'fast'), context(), { deadline: Date.now() + 90_000 });
            await jest.advanceTimersByTimeAsync(80_000);
            const text = await pending;
            expect(text).toMatch(/Sub-task 1: slow\]\n\(The sub-agent ran out of time/);
            expect(text).toMatch(/Sub-task 2: fast\]\nquick/);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('bounds', () => {
    test('at most a few at a time', async () => {
        const many = Array.from({ length: MAX_CHILDREN_PER_CALL + 1 }, (_, i) => `piece ${i}`);
        expect(await runDelegation(tasks(...many), context(), { deadline: later() })).toMatch(/at most 4 sub-tasks/);
        expect(getCompletion).not.toHaveBeenCalled();
    });

    test('and a ceiling over the whole task', async () => {
        const ctx = context();
        await runDelegation(tasks('1', '2', '3', '4'), ctx, { deadline: later() });
        await runDelegation(tasks('5', '6', '7'), ctx, { deadline: later() });
        expect(await runDelegation(tasks('8', '9'), ctx, { deadline: later() })).toMatch(/only 1 more sub-task\b/);
        await runDelegation(tasks('8'), ctx, { deadline: later() });
        expect(await runDelegation(tasks('9'), ctx, { deadline: later() })).toMatch(/used all its sub-tasks/);
        expect(getCompletion).toHaveBeenCalledTimes(MAX_CHILDREN_PER_TASK);
    });

    test('the ceiling is per task: each tool keeps its own count', async () => {
        const first = delegateTool(context());
        const second = delegateTool(context());
        for (let n = 0; n < 2; n++) await first.run(tasks('a', 'b', 'c', 'd'), { deadline: later() });
        expect(await first.run(tasks('e'), { deadline: later() })).toMatch(/used all its sub-tasks/);
        expect(await second.run(tasks('e'), { deadline: later() })).toMatch(/Sub-task 1: e/);
    });

    test('nothing starts without time left for it and the report', async () => {
        expect(await runDelegation(tasks('a'), context(), { deadline: Date.now() + 45_000 })).toMatch(/not enough time/);
        expect(getCompletion).not.toHaveBeenCalled();
    });

    test('nothing to delegate is answered, not run', async () => {
        expect(await runDelegation({ tasks: [] }, context(), { deadline: later() })).toMatch(/at least one sub-task/);
        expect(await runDelegation({ tasks: [{ instruction: '  ' }] }, context(), { deadline: later() })).toMatch(/at least one/);
    });
});

describe('children cannot recurse or write', () => {
    test('they get read-only tools: no delegate, no image, no note, no in-channel action', async () => {
        await runDelegation(tasks('a'), context(), { deadline: later() });
        const names = getCompletion.mock.calls[0][0].botTools.map(tool => tool.name);
        expect(names).toEqual(expect.arrayContaining(['read_webpage']));
        expect(names).not.toContain('delegate');
        expect(names).not.toContain('generate_image');
        expect(names).not.toContain('learn');
        expect(names).not.toContain('create_reminder');
        expect(getCompletion.mock.calls[0][0].botTools.every(tool => tool.annotations.readOnlyHint === true)).toBe(true);
    });

    test('a server\'s tool that needs approval runs only where the guild allowed it unattended', async () => {
        await runDelegation(tasks('a'), context(), { deadline: later() });
        const { confirmTool } = getCompletion.mock.calls[0][0];
        await expect(confirmTool({ server: 'github', tool: 'create_issue' })).resolves.toMatchObject({ approved: false });
        await expect(confirmTool({ server: 'clawdia', tool: 'save_memory' })).resolves.toMatchObject({ approved: false });
    });
});

describe('spend stays inside the task\'s limits', () => {
    test('no message slot of their own: no user and no channel on the child turn', async () => {
        await runDelegation(tasks('a'), context(), { deadline: later() });
        const [req] = getCompletion.mock.calls[0];
        expect(req.userId).toBeUndefined();
        expect(req.channelId).toBeUndefined();
        // Still the guild's, so the ledger and the monthly ceiling see it.
        expect(req.guildId).toBe('g1');
        expect(req.rateLimit).toBe(CONFIG.rateLimit);
    });

    test('their tool calls come out of the person\'s own tool window', async () => {
        const userId = nextUser();
        await runDelegation(tasks('a'), context({ userId }), { deadline: later() });
        const childBudget = getCompletion.mock.calls[0][0].toolBudget;
        const allowance = CONFIG.rateLimit.perUser * TOOL_CALLS_PER_MESSAGE;

        for (let n = 0; n < allowance; n++) expect(childBudget()).toBe(true);
        expect(childBudget()).toBe(false);
        // The task's own budget is the same window, now spent.
        expect(toolCallBudget({ guildId: 'g1', userId, rateLimit: CONFIG.rateLimit }).peek()).toBe(false);
    });

    test('a scheduled run\'s children spend the guild\'s hourly scheduled budget', async () => {
        const guildId = `g-del-sched-${++seq}`;
        await runDelegation(tasks('a'), context({ guildId, userId: null }), { deadline: later() });
        const childBudget = getCompletion.mock.calls[0][0].toolBudget;
        while (childBudget()) { /* spend it all */ }
        expect(toolCallBudget({ guildId, userId: null }).peek()).toBe(false);
    });
});

describe('getCompletion takes the shared budget', () => {
    test('a passed toolBudget is used instead of the one the user would get', async () => {
        jest.resetModules();
        jest.unmock('../src/services/ai/index');
        const mockComplete = jest.fn(async () => ({ text: 'ok' }));
        jest.doMock('../src/services/ai/providers', () => {
            const actual = jest.requireActual('../src/services/ai/providers');
            return { ...actual, getProvider: () => ({ complete: mockComplete }) };
        });
        const { getCompletion: real } = require('../src/services/ai/index');
        const shared = jest.fn(() => true);

        await real({ provider: 'openai', model: 'gpt-test', apiKey: 'k', guildId: null, toolBudget: shared });

        expect(mockComplete.mock.calls[0][0].toolBudget).toBe(shared);

        // An unbounded parent passes null, which stays unbounded rather than
        // falling to the per-guild scheduled budget a userless call gets.
        await real({ provider: 'openai', model: 'gpt-test', apiKey: 'k', guildId: 'g1', toolBudget: null });
        expect(mockComplete.mock.calls[1][0].toolBudget).toBeNull();
        await real({ provider: 'openai', model: 'gpt-test', apiKey: 'k', guildId: 'g1' });
        expect(typeof mockComplete.mock.calls[2][0].toolBudget).toBe('function');
        jest.dontMock('../src/services/ai/providers');
    });
});
