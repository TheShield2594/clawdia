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
const aiService = require('../src/services/aiService');
const { runJob } = require('../src/utils/jobRunner');
const { runDueTasks, createTask, __test__ } = require('../src/services/scheduledTaskService');
const { MAX_TASK_FAILURES, MAX_TASKS_PER_GUILD, MAX_TASKS_PER_USER, MAX_TASK_PROMPT_LENGTH } =
    require('../src/utils/scheduledTaskLimits');

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
        const next = nextOccurrence(new Date('2026-01-31T09:00:00Z'), 'monthly', 'Etc/UTC', new Date('2026-01-31T09:01:00Z'));
        expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z');
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
});
