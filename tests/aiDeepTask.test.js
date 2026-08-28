'use strict';

// Deep task mode (#835).
//
// The MCP loop is tuned for a mention-reply: four tool rounds and ninety
// seconds, which are the right numbers when somebody is watching a message sit
// on an ellipsis and the wrong ones for "check these three feeds and diff them
// against last week". These tests are about the three things that make the
// larger ceilings safe to hand out — the guild has to have opted in, the person
// has their own allowance, and the run is attributed — plus the two that make
// them work at all: the ceilings actually reach the toolkit, and a failure
// reaches the channel rather than a webhook nobody is holding.

jest.mock('../src/services/ai/index', () => ({
    resolveProviderConfig: jest.requireActual('../src/services/ai/index').resolveProviderConfig,
    getCompletion: jest.fn(async () => 'the report'),
}));
jest.mock('../src/services/ai/mcp/usage', () => ({ recordToolCalls: jest.fn(async () => {}) }));
jest.mock('../src/services/ai/mcp/approval', () => ({ createToolConfirmer: jest.fn(() => 'confirmer') }));
jest.mock('../src/models/Reminder', () => ({ countDocuments: jest.fn(async () => 0), create: jest.fn(async () => ({})) }));
jest.mock('../src/models/Poll', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/ScheduledTask', () => ({ countDocuments: jest.fn(async () => 0), create: jest.fn(async () => ({})) }));

const { getCompletion } = require('../src/services/ai/index');
const { runDeepTask, refuseTask, __test__ } = require('../src/services/ai/deepTask');
const { TASK_MAX_TOOL_ROUNDS, TASK_TURN_BUDGET_MS, MAX_TOOL_ROUNDS, TURN_BUDGET_MS } =
    require('../src/services/ai/mcp/toolkit');
const { DEEP_TASKS_PER_WINDOW } = require('../src/services/ai/rateLimit');

const AI = {
    enabled: true,
    taskModeEnabled: true,
    provider: 'openai',
    openaiKey: 'sk-test',
    model: 'gpt-test',
    systemPrompt: 'You are Clawdia.',
};

let seq = 0;
const nextUser = () => ({ id: `u-${++seq}` });

function scene({ ai = AI, editFails = false } = {}) {
    const progress = {
        edit: jest.fn(async () => { if (editFails) throw new Error('gone'); }),
    };
    const channel = {
        id: 'c1',
        isTextBased: () => true,
        send: jest.fn(async () => progress),
    };
    return {
        ai,
        guild: { id: 'g1' },
        channel,
        user: nextUser(),
        member: { permissions: { has: () => false } },
        prompt: 'check the three feeds and tell me what changed',
        __progress: progress,
    };
}

const run = args => runDeepTask(args);

beforeEach(() => {
    jest.clearAllMocks();
    getCompletion.mockResolvedValue('the report');
});

describe('who may start a task', () => {
    it('refuses when the guild has not switched task mode on', () => {
        expect(refuseTask({ ai: { ...AI, taskModeEnabled: false }, guildId: 'g1', userId: 'u1' }))
            .toMatch(/switched off on this server/);
    });

    it('refuses when the AI itself is off', () => {
        expect(refuseTask({ ai: { ...AI, enabled: false }, guildId: 'g1', userId: 'u1' }))
            .toMatch(/AI is switched off/);
    });

    it('refuses when the provider has no key', () => {
        expect(refuseTask({ ai: { ...AI, openaiKey: null }, guildId: 'g1', userId: 'u1' }))
            .toMatch(/not configured/);
    });

    it('gives each person a small allowance of their own', () => {
        // The turn is attributed, so the guild's ordinary message and tool
        // windows already apply. This is the extra one: a guild that allowed
        // twenty messages an hour did not thereby allow twenty of these.
        const userId = `u-allowance-${++seq}`;
        for (let n = 0; n < DEEP_TASKS_PER_WINDOW; n++) {
            expect(refuseTask({ ai: AI, guildId: 'g1', userId })).toBeNull();
        }
        expect(refuseTask({ ai: AI, guildId: 'g1', userId })).toMatch(/used up your deep tasks/);
    });

    it('scopes that allowance per guild, like every other window here', () => {
        const userId = `u-scoped-${++seq}`;
        for (let n = 0; n < DEEP_TASKS_PER_WINDOW; n++) refuseTask({ ai: AI, guildId: 'gA', userId });
        expect(refuseTask({ ai: AI, guildId: 'gA', userId })).toMatch(/used up/);
        expect(refuseTask({ ai: AI, guildId: 'gB', userId })).toBeNull();
    });
});

describe('what a task turn asks the provider for', () => {
    it('asks for the larger ceilings, which is the whole point', async () => {
        await run(scene());

        const [req] = getCompletion.mock.calls[0];
        expect(req.maxRounds).toBe(TASK_MAX_TOOL_ROUNDS);
        expect(req.turnBudgetMs).toBe(TASK_TURN_BUDGET_MS);
        // And they are genuinely larger than what a chat message gets, or this
        // is an elaborate no-op.
        expect(TASK_MAX_TOOL_ROUNDS).toBeGreaterThan(MAX_TOOL_ROUNDS);
        expect(TASK_TURN_BUDGET_MS).toBeGreaterThan(TURN_BUDGET_MS);
    });

    it('attributes the run, so the guild\'s ordinary windows still bound it', async () => {
        const s = scene();
        await run(s);

        const [req] = getCompletion.mock.calls[0];
        expect(req.userId).toBe(s.user.id);
        expect(req.channelId).toBe('c1');
        expect(req.guildId).toBe('g1');
        expect(req.rateLimit).toBeDefined();
    });

    it('tells the model it has room, and that nobody is waiting', async () => {
        await run(scene());

        const [req] = getCompletion.mock.calls[0];
        expect(req.systemPrompt).toContain('You are Clawdia.');
        expect(req.systemPrompt).toMatch(/running a \*\*task\*\*/);
        expect(req.systemPrompt).toMatch(new RegExp(`${TASK_MAX_TOOL_ROUNDS} rounds`));
        // A model given twelve rounds still answers in one if everything else
        // about the prompt says it is in a chat.
        expect(req.systemPrompt).toMatch(/Do not ask a clarifying question/);
        // Starts from the request, with no chat history behind it.
        expect(req.history).toEqual([]);
        expect(req.prompt).toBe('check the three feeds and tell me what changed');
    });

    it('offers the bot\'s own tools only where the guild allows actions', async () => {
        await run(scene());
        expect(getCompletion.mock.calls[0][0].botTools).toEqual([]);

        await run(scene({ ai: { ...AI, actionsEnabled: true } }));
        expect(getCompletion.mock.calls[1][0].botTools.map(tool => tool.name))
            .toContain('create_reminder');
    });
});

describe('what lands in the channel', () => {
    it('posts a progress message first, then edits the result into it', async () => {
        const s = scene();
        await run(s);

        expect(s.channel.send).toHaveBeenCalledTimes(1);
        expect(s.channel.send.mock.calls[0][0].content).toMatch(/working on/);

        const final = s.__progress.edit.mock.calls.at(-1)[0];
        expect(final.content).toContain('the report');
        // The person who asked is the one mention this is allowed to make; the
        // rest of the text is whatever the model and the servers wrote.
        expect(final.allowedMentions).toEqual({ users: [s.user.id] });
    });

    it('reports a failure into the channel rather than losing it', async () => {
        // The interaction was answered minutes ago, so a throw here has nowhere
        // else to surface.
        const s = scene();
        getCompletion.mockRejectedValue(new Error('provider exploded'));

        await expect(run(s)).resolves.toBeUndefined();

        const final = s.__progress.edit.mock.calls.at(-1)[0];
        expect(final.content).toMatch(/could not be finished/);
        // Never the provider's own error text, which is not something to paste
        // into a channel.
        expect(final.content).not.toMatch(/exploded/);
    });

    it('shows a rate-limit refusal in its own words', async () => {
        const s = scene();
        const refusal = Object.assign(new Error('This server has reached its monthly AI budget.'), { rateLimited: true });
        getCompletion.mockRejectedValue(refusal);

        await run(s);

        expect(s.__progress.edit.mock.calls.at(-1)[0].content).toMatch(/monthly AI budget/);
    });

    it('says something even when the model returned nothing', async () => {
        const s = scene();
        getCompletion.mockResolvedValue('   ');

        await run(s);

        expect(s.__progress.edit.mock.calls.at(-1)[0].content).toMatch(/without producing anything/);
    });

    it('falls back to a fresh message when the progress message could not be posted', async () => {
        const s = scene();
        s.channel.send.mockResolvedValueOnce(null);

        await run(s);

        // Two sends: the failed placeholder, then the result itself.
        expect(s.channel.send).toHaveBeenCalledTimes(2);
        expect(s.channel.send.mock.calls[1][0].content).toContain('the report');
    });

    it('splits a long report across messages rather than truncating it to one', async () => {
        const s = scene();
        getCompletion.mockResolvedValue('para\n'.repeat(1200));

        await run(s);

        expect(s.channel.send.mock.calls.length).toBeGreaterThan(1);
    });
});

describe('chunking', () => {
    const { chunk } = __test__;

    it('leaves a short answer as one piece', () => {
        expect(chunk('short')).toEqual(['short']);
    });

    it('breaks between paragraphs where it can', () => {
        const text = `${'a'.repeat(1900)}\n${'b'.repeat(500)}`;
        const [first, second] = chunk(text);
        expect(first).toBe('a'.repeat(1900));
        expect(second).toBe('b'.repeat(500));
    });

    it('stops at the message cap rather than filling the channel', () => {
        const pieces = chunk('x'.repeat(50_000));
        expect(pieces.length).toBeLessThanOrEqual(4);
        expect(pieces.at(-1).endsWith('…')).toBe(true);
    });
});
