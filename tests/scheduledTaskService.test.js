'use strict';

// Every dynamic schedule in this codebase used to be bespoke, and each one got
// at least one of "is it time yet", "did we already run" and "what happens
// after downtime" subtly wrong. ScheduledTask generalizes the one pattern that
// gets all three right — the reminder scan (#834) — so these tests are mostly
// about the three: claiming exactly once, skipping missed occurrences rather
// than replaying them, and giving up on a task that keeps failing.

jest.mock('../src/models/ScheduledTask', () => ({
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(async () => ({})),
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(async doc => ({ _id: 'new-task', ...doc })),
}));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn() }));
jest.mock('../src/services/aiService', () => ({
    resolveProviderConfig: jest.fn(() => ({ provider: 'mock', apiKey: 'k', model: 'm' })),
    getCompletion: jest.fn(async () => 'the answer'),
}));
// The real runJob swallows the throw into the dead-letter queue and reports
// through the health surface, which is exactly what a task is put through it
// for; the mock has to swallow too, or a failing task takes the tick down.
jest.mock('../src/utils/jobRunner', () => ({
    runJob: jest.fn(async (service, name, fn) => {
        try { await fn(); } catch { /* recorded by the real runJob */ }
        return true;
    })
}));

const ScheduledTask = require('../src/models/ScheduledTask');
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const aiService = require('../src/services/aiService');
const { runJob } = require('../src/utils/jobRunner');
const { runDueTasks, createTask, __test__ } = require('../src/services/scheduledTaskService');
const {
    MAX_TASK_FAILURES, MAX_TASKS_PER_GUILD, MAX_TASKS_PER_USER,
    MAX_TASK_PROMPT_LENGTH, MAX_TASK_DELAY_MINUTES, MIN_CRON_INTERVAL_MINUTES, MIN_DEEP_CRON_INTERVAL_MINUTES, TASK_RUN_TIMEOUT_MS
} = require('../src/utils/scheduledTaskLimits');

const NOW = new Date('2026-07-14T09:00:00Z');

function makeTask(overrides = {}) {
    return {
        _id: 'task-1',
        guildId: 'g1',
        kind: 'ai_prompt',
        channelId: 'chan1',
        createdBy: 'u1',
        prompt: 'Recap #announcements',
        fireAt: new Date('2026-07-14T08:59:00Z'),
        repeat: null,
        timezone: 'Etc/UTC',
        enabled: true,
        failureCount: 0,
        ...overrides
    };
}

/** `find(...).sort(...).limit(...)` resolving to `tasks`. */
function due(tasks) {
    ScheduledTask.find.mockReturnValue({ sort: () => ({ limit: async () => tasks }) });
}

function makeClient(channel) {
    return {
        channels: {
            cache: { get: jest.fn().mockReturnValue(channel) },
            fetch: jest.fn(async () => { if (!channel) throw new Error('Unknown channel'); return channel; })
        }
    };
}

const textChannel = () => ({ isTextBased: () => true, send: jest.fn(async () => ({})) });

beforeEach(() => {
    jest.clearAllMocks();
    due([]);
    // Claimed by default: the conditional write matched.
    ScheduledTask.findOneAndUpdate.mockImplementation(async (filter, update) => ({
        ...makeTask(), ...(update.$set || {}), failureCount: 1
    }));
    Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, systemPrompt: 'be helpful' } }) });
    User.findOne.mockReturnValue({ lean: async () => null });
    aiService.getCompletion.mockResolvedValue('the answer');
});

describe('advancing a repeat', () => {
    const { nextOccurrence } = __test__;

    test('lands on the next occurrence for a daily task', () => {
        const next = nextOccurrence(new Date('2026-07-14T09:00:00Z'), 'daily', 'Etc/UTC', NOW);
        expect(next.toISOString()).toBe('2026-07-15T09:00:00.000Z');
    });

    test('skips the occurrences missed during downtime rather than replaying them', () => {
        // Three days behind. Advancing one interval per run would fire the task
        // three times in three consecutive ticks — three provider calls for one
        // day's work (the shape of #817).
        const behind = new Date('2026-07-11T09:00:00Z');
        const next = nextOccurrence(behind, 'daily', 'Etc/UTC', NOW);
        expect(next.toISOString()).toBe('2026-07-15T09:00:00.000Z');
    });

    test('keeps a weekly task on its weekday', () => {
        const next = nextOccurrence(new Date('2026-07-14T09:00:00Z'), 'weekly', 'Etc/UTC', NOW);
        expect(next.toISOString()).toBe('2026-07-21T09:00:00.000Z');
    });

    test('clamps a monthly task rather than walking it forward through the calendar', () => {
        // Date.UTC(y, m, 31) on a thirty-day month is the 1st of the month
        // after, which would march the task through the calendar a day a month.
        const next = nextOccurrence(new Date('2026-01-31T09:00:00Z'), 'monthly', 'Etc/UTC', new Date('2026-01-31T09:01:00Z'), 31);
        expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z');
    });

    test('and comes back to the day it meant once the month is long enough', () => {
        // Clamping alone is lossy: stepping from the clamped 28th of February
        // gives the 28th of March, and the 31st is gone for good after one
        // short month. Each step is measured from the day the task meant.
        const fromFebruary = nextOccurrence(new Date('2026-02-28T09:00:00Z'), 'monthly', 'Etc/UTC', new Date('2026-02-28T09:01:00Z'), 31);
        expect(fromFebruary.toISOString()).toBe('2026-03-31T09:00:00.000Z');

        const fromMarch = nextOccurrence(new Date('2026-03-31T09:00:00Z'), 'monthly', 'Etc/UTC', new Date('2026-03-31T09:01:00Z'), 31);
        expect(fromMarch.toISOString()).toBe('2026-04-30T09:00:00.000Z');
    });

    test('a task written before the anchor existed keeps the old clamping', () => {
        const next = nextOccurrence(new Date('2026-02-28T09:00:00Z'), 'monthly', 'Etc/UTC', new Date('2026-02-28T09:01:00Z'), null);
        expect(next.toISOString()).toBe('2026-03-28T09:00:00.000Z');
    });

    test('has no next occurrence for a one-shot', () => {
        expect(nextOccurrence(NOW, null, 'Etc/UTC', NOW)).toBeNull();
    });
});

describe('claiming a due task', () => {
    test('reschedules a repeating task in the same write that claims it', async () => {
        const client = makeClient(textChannel());
        due([makeTask({ repeat: 'daily', fireAt: new Date('2026-07-13T09:00:00Z') })]);

        await runDueTasks(client);

        const [filter, update] = ScheduledTask.findOneAndUpdate.mock.calls[0];
        // Conditional on the value it read, so a second tick — or a second
        // process — finds nothing to claim.
        expect(filter).toMatchObject({ _id: 'task-1', enabled: true });
        expect(filter.fireAt).toEqual(new Date('2026-07-13T09:00:00Z'));
        expect(update.$set.fireAt.getTime()).toBeGreaterThan(Date.now());
        expect(update.$set.enabled).toBeUndefined();
        expect(update.$inc).toEqual({ runCount: 1 });
    });

    test('switches a one-shot off instead of rescheduling it', async () => {
        due([makeTask({ repeat: null })]);
        await runDueTasks(makeClient(textChannel()));

        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[0];
        expect(update.$set.enabled).toBe(false);
        expect(update.$set.fireAt).toBeUndefined();
    });

    test('does not run a task another process claimed first', async () => {
        due([makeTask()]);
        ScheduledTask.findOneAndUpdate.mockResolvedValueOnce(null);

        await runDueTasks(makeClient(textChannel()));

        expect(runJob).not.toHaveBeenCalled();
        expect(aiService.getCompletion).not.toHaveBeenCalled();
    });

    test('advances a monthly task from the day it meant, not the last clamp', async () => {
        // On the real clock this test asserted whatever month it happened to run
        // in. runDueTasks() reads `new Date()` (unlike nextOccurrence(), which
        // takes `now`), so the occurrence it lands on moves with the calendar —
        // and lands on a 30-day month one run in three, where a monthDay of 31
        // correctly clamps to 30 and the assertion below fails. It ran green for
        // months and went red on the 31st.
        //
        // Pinned to the NOW the rest of this file already uses, which puts the
        // next occurrence in July: a 31-day month, so the day survives and the
        // property being tested is the one actually asserted. The clamping
        // behaviour on a short month is nextOccurrence()'s own business and is
        // covered above, where `now` is a parameter rather than the wall clock.
        jest.useFakeTimers().setSystemTime(NOW);
        try {
            due([makeTask({
                repeat: 'monthly', monthDay: 31,
                fireAt: new Date('2026-02-28T09:00:00Z'), timezone: 'Etc/UTC',
            })]);

            await runDueTasks(makeClient(textChannel()));
        } finally {
            jest.useRealTimers();
        }

        // Months behind, so the claim skips forward to the next future
        // occurrence — and the day the task meant survives every one of those
        // steps rather than being lost to the first short month it crossed.
        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[0];
        expect(update.$set.fireAt.getUTCDate()).toBe(31);
        expect(update.$set.fireAt.getTime()).toBeGreaterThan(NOW.getTime());
    });

    test('moves a cron task to its next occurrence after now, skipping the ones missed', async () => {
        // Weekdays at nine, last due on a Monday a week ago; NOW is Tuesday
        // 2026-07-14 09:00 UTC, so Tuesday's run is the one being claimed and
        // the next is Wednesday's — not the six missed in between.
        jest.useFakeTimers().setSystemTime(NOW);
        try {
            due([makeTask({ cron: '0 9 * * 1-5', fireAt: new Date('2026-07-06T09:00:00Z') })]);
            await runDueTasks(makeClient(textChannel()));
        } finally {
            jest.useRealTimers();
        }

        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[0];
        expect(update.$set.fireAt).toEqual(new Date('2026-07-15T09:00:00Z'));
        expect(update.$set.enabled).toBeUndefined();
    });

    test('retires a cron task whose expression no longer parses rather than refiring it', async () => {
        due([makeTask({ cron: 'not a cron line' })]);
        await runDueTasks(makeClient(textChannel()));

        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[0];
        expect(update.$set.enabled).toBe(false);
    });

    test('runs each task inside its own job scope, so one guild cannot drop another', async () => {
        due([makeTask({ _id: 'a', guildId: 'g1' }), makeTask({ _id: 'b', guildId: 'g2' })]);

        await runDueTasks(makeClient(textChannel()));

        expect(runJob).toHaveBeenCalledTimes(2);
        expect(runJob.mock.calls[0][3]).toMatchObject({ guildId: 'g1', scope: 'a' });
        expect(runJob.mock.calls[1][3]).toMatchObject({ guildId: 'g2', scope: 'b' });
    });
});

describe('running an ai_prompt task', () => {
    test('posts the model\'s answer with mentions disarmed', async () => {
        const channel = textChannel();
        due([makeTask()]);
        aiService.getCompletion.mockResolvedValue('@everyone here is your recap');

        await runDueTasks(makeClient(channel));

        // Nobody is at the keyboard to notice an @everyone that got talked into
        // the answer, so the policy is not optional on this path.
        expect(channel.send).toHaveBeenCalledWith({
            content: '@everyone here is your recap',
            allowedMentions: { parse: [] }
        });
    });

    test('spends the guild\'s budget unattributed, which is what bounds it', async () => {
        due([makeTask()]);
        await runDueTasks(makeClient(textChannel()));

        const [req] = aiService.getCompletion.mock.calls[0];
        expect(req.guildId).toBe('g1');
        // No user and no channel: the per-user and per-channel windows have
        // nothing to bill this to. The monthly ceiling and the per-guild tool
        // budget (#831) are what stand in for them.
        expect(req.userId).toBeUndefined();
        expect(req.channelId).toBeUndefined();
    });

    test('tells the model the prompt is a standing instruction, not a message', async () => {
        due([makeTask()]);
        await runDueTasks(makeClient(textChannel()));

        const [req] = aiService.getCompletion.mock.calls[0];
        expect(req.systemPrompt).toContain('be helpful');
        expect(req.systemPrompt).toMatch(/standing instruction/);
        expect(req.systemPrompt).toMatch(/as data/);
        expect(req.prompt).toBe('Recap #announcements');
    });

    // The guild the creator is looked up in when a channel task reads their
    // memories: a member with Manage Server unless told otherwise.
    const withOwner = (client, owner = { permissions: { has: () => true } }) => ({
        ...client,
        guilds: { cache: { get: () => ({ members: { fetch: jest.fn(async () => { if (!owner) throw new Error('Unknown Member'); return owner; }) } }) } }
    });

    test('carries the memories of the person who set it up, and nobody else\'s', async () => {
        due([makeTask()]);
        User.findOne.mockReturnValue({ lean: async () => ({ pinnedMemories: [{ content: 'Works nights on weekdays' }] }) });
        await runDueTasks(withOwner(makeClient(textChannel())));

        expect(User.findOne).toHaveBeenCalledWith({ userId: 'u1', guildId: 'g1' }, expect.anything());
        const [req] = aiService.getCompletion.mock.calls[0];
        expect(req.history[0].content).toMatch(/Works nights on weekdays/);
        expect(req.history[0].content).toMatch(/<@u1>/);
    });

    test.each([
        ['left the server', null],
        ['lost Manage Server', { permissions: { has: () => false } }]
    ])('still runs, without their memories, once the person who set it up has %s', async (_, owner) => {
        due([makeTask()]);
        User.findOne.mockReturnValue({ lean: async () => ({ pinnedMemories: [{ content: 'Works nights on weekdays' }] }) });
        await runDueTasks(withOwner(makeClient(textChannel()), owner));

        const [req] = aiService.getCompletion.mock.calls[0];
        expect(req.history).toEqual([]);
        expect(User.findOne).not.toHaveBeenCalled();
    });

    test('runs with no memories when there are none to read, or they cannot be read', async () => {
        due([makeTask()]);
        User.findOne.mockReturnValue({ lean: async () => { throw new Error('db down'); } });
        await runDueTasks(makeClient(textChannel()));

        const [req] = aiService.getCompletion.mock.calls[0];
        expect(req.history).toEqual([]);
    });

    test('answers approvals from the connection\'s unattended list, not from a person', async () => {
        due([makeTask()]);
        aiService.resolveProviderConfig.mockReturnValueOnce({
            provider: 'mock', apiKey: 'k', model: 'm',
            mcpServers: [{
                name: 'fastmail',
                url: 'https://api.fastmail.com/mcp',
                confirmTools: ['create_event', 'send_email'],
                unattendedTools: ['create_event']
            }]
        });
        await runDueTasks(makeClient(textChannel()));

        const [req] = aiService.getCompletion.mock.calls[0];
        await expect(req.confirmTool({ server: 'fastmail', tool: 'create_event' })).resolves.toEqual({ approved: true });
        const refused = await req.confirmTool({ server: 'fastmail', tool: 'send_email' });
        expect(refused.approved).toBe(false);
        expect(refused.message).toMatch(/scheduled task/);
    });

    // `off` is a chat answer: unattended, it would let every write run with no
    // list read, since the list only answers a call that needs confirming.
    test.each([
        ['off', 'writes'], [undefined, 'writes'], ['destructive', 'writes'], ['always', 'always']
    ])('runs a guild on %s confirm mode under %s', async (mode, expected) => {
        due([makeTask()]);
        aiService.resolveProviderConfig.mockReturnValueOnce({ provider: 'mock', apiKey: 'k', model: 'm', mcpConfirm: mode });
        await runDueTasks(makeClient(textChannel()));

        expect(aiService.getCompletion.mock.calls[0][0].mcpConfirm).toBe(expected);
    });

    test('fails rather than posting when the guild has the AI switched off', async () => {
        const channel = textChannel();
        due([makeTask()]);
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: false } }) });

        await runDueTasks(makeClient(channel));

        expect(channel.send).not.toHaveBeenCalled();
        expect(ScheduledTask.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'task-1' },
            expect.objectContaining({ $inc: { failureCount: 1 } }),
            expect.anything()
        );
    });

    test('clears the failure count after a run that worked', async () => {
        due([makeTask({ failureCount: 2 })]);
        await runDueTasks(makeClient(textChannel()));

        expect(ScheduledTask.updateOne).toHaveBeenCalledWith(
            { _id: 'task-1' },
            { $set: { failureCount: 0, lastError: null } }
        );
    });

    test('switches a task off once it has failed the same way too often', async () => {
        due([makeTask()]);
        Guild.findOne.mockReturnValue({ lean: async () => null });
        ScheduledTask.findOneAndUpdate
            .mockImplementationOnce(async () => makeTask())              // the claim
            .mockImplementationOnce(async () => ({ failureCount: MAX_TASK_FAILURES })); // the count

        await runDueTasks(makeClient(textChannel()));

        expect(ScheduledTask.updateOne).toHaveBeenCalledWith({ _id: 'task-1' }, { $set: { enabled: false } });
    });

    // The tick runs its tasks one after another, so a handler that never
    // returns would hold the tick open and jobRunner would drop every later
    // tick as an overlap — one hung request stalling the whole subsystem. Of
    // the four providers only Ollama sets a request timeout of its own.
    test('gives up on a run that never finishes, so the tick is not held open', async () => {
        jest.useFakeTimers();
        try {
            due([makeTask()]);
            aiService.getCompletion.mockImplementation(() => new Promise(() => {}));

            const tick = runDueTasks(makeClient(textChannel()));
            await Promise.resolve();
            await jest.advanceTimersByTimeAsync(TASK_RUN_TIMEOUT_MS + 1);
            await tick;
        } finally {
            jest.useRealTimers();
        }

        // Counted as a failure like any other, so a task that always hangs is
        // switched off rather than hanging every tick for ever.
        expect(ScheduledTask.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'task-1' },
            expect.objectContaining({ $inc: { failureCount: 1 } }),
            expect.anything()
        );
        // And the turn itself is cancelled, so it starts no more paid rounds.
        expect(aiService.getCompletion.mock.calls[0][0].signal.aborted).toBe(true);
    });

    test('posts nothing when the answer arrives after the run was given up on', async () => {
        jest.useFakeTimers();
        const channel = textChannel();
        try {
            due([makeTask()]);
            // A provider that ignores the abort and answers late anyway.
            aiService.getCompletion.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('late'), TASK_RUN_TIMEOUT_MS + 5000)));

            const tick = runDueTasks(makeClient(channel));
            await Promise.resolve();
            await jest.advanceTimersByTimeAsync(TASK_RUN_TIMEOUT_MS + 10_000);
            await tick;
        } finally {
            jest.useRealTimers();
        }
        expect(channel.send).not.toHaveBeenCalled();
    });

    test('disables a task whose kind this version does not know', async () => {
        due([makeTask({ kind: 'from_the_future' })]);

        await runDueTasks(makeClient(textChannel()));

        expect(ScheduledTask.updateOne).toHaveBeenCalledWith(
            { _id: 'task-1' },
            { $set: { enabled: false, lastError: 'unknown task kind "from_the_future"' } }
        );
        // Not counted as a failure and not retried every minute forever.
        expect(aiService.getCompletion).not.toHaveBeenCalled();
    });
});

describe('what a run\'s tools make (#1229)', () => {
    test('a generated image is posted after the answer', async () => {
        const png = Buffer.from('png');
        aiService.getCompletion.mockImplementation(async ({ onToolEvent }) => {
            onToolEvent({ type: 'attachment', id: 1, server: 'clawdia', tool: 'generate_image', buffer: png, name: 'generated-image-1.png' });
            return 'Today\'s image';
        });
        const channel = textChannel();
        due([makeTask()]);

        await runDueTasks(makeClient(channel));

        expect(channel.send).toHaveBeenLastCalledWith({
            files: [{ attachment: png, name: 'generated-image-1.png' }],
            allowedMentions: { parse: [] }
        });
    });

    test('the image tool is offered to a scheduled run with the switch on and a key', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, imageGeneration: true, openaiKey: 'sk-test' } }) });
        due([makeTask()]);
        await runDueTasks(makeClient(textChannel()));

        expect(aiService.getCompletion.mock.calls[0][0].botTools.map(tool => tool.name)).toContain('generate_image');
    });
});

describe('running a deep task', () => {
    const { TASK_MAX_TOOL_ROUNDS, TASK_TURN_BUDGET_MS } = require('../src/services/ai/mcp/toolkit');

    beforeEach(() => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, taskModeEnabled: true } }) });
    });

    test('gets deep task mode\'s ceilings and framing, still unattributed', async () => {
        due([makeTask({ mode: 'deep' })]);
        await runDueTasks(makeClient(textChannel()));

        const request = aiService.getCompletion.mock.calls[0][0];
        expect(request).toMatchObject({ maxRounds: TASK_MAX_TOOL_ROUNDS, turnBudgetMs: TASK_TURN_BUDGET_MS });
        expect(request.systemPrompt).toMatch(/running a \*\*task\*\*/);
        expect(request.systemPrompt).toMatch(/standing instruction/);
        // Unattributed, so the guild's scheduled tool budget is what bounds it.
        expect(request.userId).toBeUndefined();
    });

    test('may delegate to sub-agents; a standard task may not (#1232)', async () => {
        due([makeTask({ mode: 'deep' }), makeTask({ _id: 'task-2' })]);
        await runDueTasks(makeClient(textChannel()));

        const [deep, standard] = aiService.getCompletion.mock.calls.map(([request]) => request);
        expect(deep.botTools.map(tool => tool.name)).toContain('delegate');
        expect(standard.botTools.map(tool => tool.name)).not.toContain('delegate');
    });

    // A deep report is several sends; a timeout during one of them must not
    // let the rest follow a run already recorded as failed.
    test('stops posting a long report once the run times out mid-send', async () => {
        jest.useFakeTimers();
        const channel = textChannel();
        try {
            due([makeTask({ mode: 'deep' })]);
            aiService.getCompletion.mockResolvedValue('word '.repeat(2000));
            // The first piece takes longer than the run has left.
            channel.send.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({}), TASK_RUN_TIMEOUT_MS + 5000)));

            const tick = runDueTasks(makeClient(channel));
            await Promise.resolve();
            await jest.advanceTimersByTimeAsync(TASK_RUN_TIMEOUT_MS + 10_000);
            await tick;
        } finally {
            jest.useRealTimers();
        }
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test('a standard task keeps the ordinary ceilings', async () => {
        due([makeTask()]);
        await runDueTasks(makeClient(textChannel()));

        const request = aiService.getCompletion.mock.calls[0][0];
        expect(request.maxRounds).toBeUndefined();
        expect(request.turnBudgetMs).toBeUndefined();
    });

    test('fails without spending anything once deep task mode is switched off', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, taskModeEnabled: false } }) });
        due([makeTask({ mode: 'deep' })]);

        await runDueTasks(makeClient(textChannel()));

        expect(aiService.getCompletion).not.toHaveBeenCalled();
        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[1];
        expect(update.$set.lastError).toMatch(/deep task mode is switched off/);
    });

    test('splits a long report over several messages, none past the limit', async () => {
        aiService.getCompletion.mockResolvedValue(Array.from({ length: 60 }, (_, i) => `Finding ${i}: ${'x'.repeat(90)}`).join('\n'));
        const channel = textChannel();
        due([makeTask({ mode: 'deep' })]);

        await runDueTasks(makeClient(channel));

        expect(channel.send.mock.calls.length).toBeGreaterThan(1);
        for (const [payload] of channel.send.mock.calls) {
            expect(payload.content.length).toBeLessThanOrEqual(2000);
            expect(payload.allowedMentions).toEqual({ parse: [] });
        }
    });
});

describe('running a task that delivers by DM', () => {
    function dmClient({ member = undefined, fetchThrows = false } = {}) {
        const recipient = member === undefined
            ? { permissions: { has: () => true }, send: jest.fn(async () => ({})) }
            : member;
        const guild = {
            name: 'Test Server',
            members: { fetch: jest.fn(async () => { if (fetchThrows) throw new Error('Unknown Member'); return recipient; }) }
        };
        return { client: { ...makeClient(null), guilds: { cache: { get: () => guild } } }, recipient, guild };
    }

    test('sends the answer to the person who set it up, saying where it came from', async () => {
        const { client, recipient, guild } = dmClient();
        due([makeTask({ _id: 'aaaaaa123456', deliverTo: 'dm' })]);

        await runDueTasks(client);

        expect(guild.members.fetch).toHaveBeenCalledWith('u1');
        const sent = recipient.send.mock.calls[0][0];
        expect(sent.content).toMatch(/`123456` from \*\*Test Server\*\*/);
        expect(sent.content).toMatch(/the answer$/);
        expect(sent.allowedMentions).toEqual({ parse: [] });
        expect(sent.content.length).toBeLessThanOrEqual(2000);
    });

    test('tells the model the answer goes privately to an administrator', async () => {
        due([makeTask({ deliverTo: 'dm' })]);
        await runDueTasks(dmClient().client);

        expect(aiService.getCompletion.mock.calls[0][0].systemPrompt).toMatch(/direct message/);
    });

    test('keeps a long answer inside Discord\'s limit, header included', async () => {
        aiService.getCompletion.mockResolvedValue('x'.repeat(5000));
        const { client, recipient } = dmClient();
        due([makeTask({ deliverTo: 'dm' })]);

        await runDueTasks(client);

        expect(recipient.send.mock.calls[0][0].content).toHaveLength(2000);
    });

    test('fails without spending anything once the owner has left the server', async () => {
        due([makeTask({ deliverTo: 'dm' })]);
        await runDueTasks(dmClient({ fetchThrows: true }).client);

        expect(aiService.getCompletion).not.toHaveBeenCalled();
        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[1];
        expect(update.$set.lastError).toMatch(/no longer in this server/);
    });

    test('fails without spending anything once the owner has lost Manage Server', async () => {
        const member = { permissions: { has: () => false }, send: jest.fn() };
        due([makeTask({ deliverTo: 'dm' })]);
        await runDueTasks(dmClient({ member }).client);

        expect(aiService.getCompletion).not.toHaveBeenCalled();
        expect(member.send).not.toHaveBeenCalled();
        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[1];
        expect(update.$set.lastError).toMatch(/no longer has Manage Server/);
    });

    test('says plainly when the owner\'s DMs are closed', async () => {
        const closed = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        const member = { permissions: { has: () => true }, send: jest.fn(async () => { throw closed; }) };
        due([makeTask({ deliverTo: 'dm' })]);

        await runDueTasks(dmClient({ member }).client);

        const [, update] = ScheduledTask.findOneAndUpdate.mock.calls[1];
        expect(update.$set.lastError).toMatch(/DMs are closed/);
    });
});

describe('createTask, the one gate both routes go through', () => {
    const BASE = {
        guildId: 'g1', channelId: 'c1', createdBy: 'u1',
        prompt: 'do the thing', fireAt: new Date(Date.now() + 60_000)
    };

    test('creates a task when everything fits', async () => {
        const { task, error } = await createTask(BASE);
        expect(error).toBeUndefined();
        expect(task).toMatchObject({ guildId: 'g1', kind: 'ai_prompt', prompt: 'do the thing' });
    });

    test('refuses a kind with no handler', async () => {
        const { error } = await createTask({ ...BASE, kind: 'rm_rf' });
        expect(error).toMatch(/no scheduled task kind/i);
        expect(ScheduledTask.create).not.toHaveBeenCalled();
    });

    test('refuses a cadence that is not one of the three', async () => {
        const { error } = await createTask({ ...BASE, repeat: 'hourly' });
        expect(error).toMatch(/daily, weekly or monthly/);
    });

    test('refuses an instruction that is too long rather than truncating it', async () => {
        // Truncating would leave a standing instruction whose second half is
        // missing, running every day, with nobody reading it.
        const { error } = await createTask({ ...BASE, prompt: 'x'.repeat(MAX_TASK_PROMPT_LENGTH + 1) });
        expect(error).toMatch(new RegExp(`${MAX_TASK_PROMPT_LENGTH} characters`));
    });

    test('refuses an empty instruction', async () => {
        const { error } = await createTask({ ...BASE, prompt: '   ' });
        expect(error).toMatch(/needs an instruction/);
    });

    test('holds the per-guild cap', async () => {
        ScheduledTask.countDocuments.mockResolvedValueOnce(MAX_TASKS_PER_GUILD);
        const { error } = await createTask(BASE);
        expect(error).toMatch(new RegExp(`maximum of ${MAX_TASKS_PER_GUILD}`));
    });

    test('holds the per-person cap, so one member cannot fill the server\'s', async () => {
        ScheduledTask.countDocuments
            .mockResolvedValueOnce(0)                    // guild
            .mockResolvedValueOnce(MAX_TASKS_PER_USER);  // user
        const { error } = await createTask(BASE);
        expect(error).toMatch(new RegExp(`maximum of ${MAX_TASKS_PER_USER}`));
    });

    test('counts only the tasks that are switched on', async () => {
        await createTask(BASE);
        // A task somebody kept, disabled, for reference should not hold a slot.
        expect(ScheduledTask.countDocuments).toHaveBeenCalledWith({ guildId: 'g1', enabled: true });
    });

    test('refuses a task with nowhere to post', async () => {
        const { error } = await createTask({ ...BASE, channelId: null });
        expect(error).toMatch(/server and a channel/);
    });

    test('refuses a time it cannot schedule', async () => {
        const { error } = await createTask({ ...BASE, fireAt: new Date('nonsense') });
        expect(error).toMatch(/not a time/);
    });

    test('refuses a first run in the past', async () => {
        const { error } = await createTask({ ...BASE, fireAt: new Date(Date.now() - 60_000) });
        expect(error).toMatch(/already passed/);
        expect(ScheduledTask.create).not.toHaveBeenCalled();
    });

    test('holds the maximum delay here, not only at the slash command', async () => {
        const tooFar = new Date(Date.now() + (MAX_TASK_DELAY_MINUTES + 60) * 60_000);
        const { error } = await createTask({ ...BASE, fireAt: tooFar });
        expect(error).toMatch(/at most a year/);
    });

    test('accepts the model tool\'s own minimum, which arrives a shade under a minute', async () => {
        // The tool builds `now + 1 minute` and hands it over milliseconds
        // later, so a strict minute floor would refuse its own minimum.
        const { error } = await createTask({ ...BASE, fireAt: new Date(Date.now() + 59_900) });
        expect(error).toBeUndefined();
    });

    test('refuses a timezone it cannot use', async () => {
        // It decides where every later occurrence lands, and it arrives from
        // guild settings somebody typed.
        const { error } = await createTask({ ...BASE, timezone: 'Mars/Olympus_Mons' });
        expect(error).toMatch(/not a timezone/);
        expect(ScheduledTask.create).not.toHaveBeenCalled();
    });

    test('records the day a monthly task means', async () => {
        await createTask({ ...BASE, repeat: 'monthly', timezone: 'Etc/UTC', fireAt: new Date('2027-01-31T09:00:00Z') });
        expect(ScheduledTask.create).toHaveBeenCalledWith(expect.objectContaining({ monthDay: 31 }));
    });

    test('a cron task with no first run gets the expression\'s first occurrence', async () => {
        const { task, error } = await createTask({ ...BASE, fireAt: undefined, cron: '0 9 * * 1-5', timezone: 'America/New_York' });

        expect(error).toBeUndefined();
        expect(task.cron).toBe('0 9 * * 1-5');
        expect(task.repeat).toBeNull();
        expect(task.fireAt.getTime()).toBeGreaterThan(Date.now());
        // 09:00 in New York is 13:00 or 14:00 UTC depending on the season.
        expect([13, 14]).toContain(task.fireAt.getUTCHours());
        expect([1, 2, 3, 4, 5]).toContain(task.fireAt.getUTCDay());
    });

    test('a cron task keeps a first run it was given', async () => {
        const fireAt = new Date(Date.now() + 5 * 60_000);
        const { task } = await createTask({ ...BASE, fireAt, cron: '0 9 * * *' });
        expect(task.fireAt).toBe(fireAt);
    });

    test('refuses a cron line that would run more often than the floor', async () => {
        const { error } = await createTask({ ...BASE, cron: '*/5 * * * *' });
        expect(error).toMatch(new RegExp(`every ${MIN_CRON_INTERVAL_MINUTES} minutes`));
        expect(ScheduledTask.create).not.toHaveBeenCalled();
    });

    test('refuses a cron line it cannot read, saying why', async () => {
        const { error } = await createTask({ ...BASE, cron: '0 25 * * *' });
        expect(error).toMatch(/out of range for the hour field/);
    });

    test('refuses a cron line that never fires', async () => {
        const { error } = await createTask({ ...BASE, cron: '0 0 31 2 *' });
        expect(error).toMatch(/never fires/);
    });

    test('records where the result goes, defaulting to the channel', async () => {
        await createTask(BASE);
        expect(ScheduledTask.create).toHaveBeenLastCalledWith(expect.objectContaining({ deliverTo: 'channel' }));
        await createTask({ ...BASE, deliverTo: 'dm' });
        expect(ScheduledTask.create).toHaveBeenLastCalledWith(expect.objectContaining({ deliverTo: 'dm' }));
    });

    test('refuses a destination that is not a channel or a DM', async () => {
        const { error } = await createTask({ ...BASE, deliverTo: 'email' });
        expect(error).toMatch(/channel or by DM/);
    });

    test('refuses a DM task with nobody to send it to', async () => {
        const { error } = await createTask({ ...BASE, createdBy: null, deliverTo: 'dm' });
        expect(error).toMatch(/needs a person/);
    });

    test('refuses a deep task while the server has deep task mode off', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, taskModeEnabled: false } }) });
        const { error } = await createTask({ ...BASE, mode: 'deep' });
        expect(error).toMatch(/Deep task mode is switched off/);
        expect(ScheduledTask.create).not.toHaveBeenCalled();
    });

    test('records a deep task once the mode is on', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, taskModeEnabled: true } }) });
        await createTask({ ...BASE, mode: 'deep' });
        expect(ScheduledTask.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'deep' }));
    });

    test('holds a deep cron task to the hourly floor', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, taskModeEnabled: true } }) });
        const { error } = await createTask({ ...BASE, mode: 'deep', cron: '*/30 * * * *' });
        expect(error).toMatch(new RegExp(`every ${MIN_DEEP_CRON_INTERVAL_MINUTES} minutes`));

        const { task } = await createTask({ ...BASE, fireAt: undefined, mode: 'deep', cron: '0 * * * *' });
        expect(task.mode).toBe('deep');
    });

    test('refuses a mode that is not standard or deep', async () => {
        const { error } = await createTask({ ...BASE, mode: 'turbo' });
        expect(error).toMatch(/standard or deep/);
    });

    test('refuses a named cadence and a cron line together', async () => {
        const { error } = await createTask({ ...BASE, repeat: 'daily', cron: '0 9 * * *' });
        expect(error).toMatch(/not both/);
    });

    test('and leaves it unset for a cadence that has no day of the month', async () => {
        await createTask({ ...BASE, repeat: 'weekly' });
        expect(ScheduledTask.create).toHaveBeenCalledWith(expect.objectContaining({ monthDay: null }));
    });
});
