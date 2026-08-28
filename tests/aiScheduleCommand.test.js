'use strict';

// `/ai schedule` and `/ai task` — the two ways a person reaches the work the
// bot does when nobody is talking to it (#834, #835).
//
// Both spend the guild's AI budget on something nobody is watching arrive, so
// the load-bearing parts are the permission gate, the caps, and — for a task —
// that the command answers the interaction and gets out of the way rather than
// holding a webhook open for eight minutes.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/ScheduledTask', () => ({
    find: jest.fn(),
    deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
}));
jest.mock('../src/services/scheduledTaskService', () => ({ createTask: jest.fn() }));
jest.mock('../src/services/ai/deepTask', () => ({
    runDeepTask: jest.fn(async () => {}),
    refuseTask: jest.fn(() => null),
}));

const Guild = require('../src/models/Guild');
const ScheduledTask = require('../src/models/ScheduledTask');
const { createTask } = require('../src/services/scheduledTaskService');
const { runDeepTask, refuseTask } = require('../src/services/ai/deepTask');
const command = require('../src/commands/ai/ai');
const { MAX_TASK_DELAY_MINUTES } = require('../src/utils/scheduledTaskLimits');

const MANAGE_GUILD = 1n << 5n;

function interaction({
    group = 'schedule',
    sub,
    strings = {},
    integers = {},
    channelOption = undefined,
    manageGuild = true,
} = {}) {
    const replies = [];
    const channel = { id: 'c1', isTextBased: () => true, toString: () => '<#c1>' };
    return {
        replies,
        guild: { id: 'g1' },
        channel,
        user: { id: 'u1' },
        member: { id: 'u1' },
        memberPermissions: { has: flag => manageGuild && flag === MANAGE_GUILD },
        options: {
            getSubcommandGroup: () => group,
            getSubcommand: () => sub,
            getString: name => strings[name] ?? null,
            getInteger: name => integers[name] ?? null,
            getChannel: () => (channelOption === undefined ? null : channelOption),
        },
        reply: async payload => { replies.push(payload); return payload; },
    };
}

const said = i => (typeof i.replies[0] === 'string' ? i.replies[0] : i.replies[0]?.content) || '';

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { enabled: true, taskModeEnabled: true } }) });
    ScheduledTask.find.mockReturnValue({ sort: () => ({ limit: async () => [] }) });
    createTask.mockResolvedValue({ task: { _id: 'aaaabbbbcccc123456', fireAt: new Date(Date.now() + 3_600_000), repeat: 'daily' } });
    refuseTask.mockReturnValue(null);
});

describe('who may manage scheduled tasks', () => {
    it('turns away anyone without Manage Server', async () => {
        const i = interaction({ sub: 'list', manageGuild: false });
        await command.execute(i);

        expect(said(i)).toMatch(/Manage Server/);
        expect(ScheduledTask.find).not.toHaveBeenCalled();
    });
});

describe('/ai schedule add', () => {
    const add = extra => interaction({
        sub: 'add',
        strings: { instruction: 'recap #announcements', every: 'daily', ...extra?.strings },
        integers: { in_minutes: 60, ...extra?.integers },
        ...extra,
    });

    it('creates the task and says when it first runs', async () => {
        const i = add();
        await command.execute(i);

        expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
            guildId: 'g1', channelId: 'c1', createdBy: 'u1',
            kind: 'ai_prompt', prompt: 'recap #announcements', repeat: 'daily',
        }));
        expect(said(i)).toMatch(/<t:\d+:F>/);
        // The cost is stated where somebody setting one up will read it.
        expect(said(i)).toMatch(/monthly budget/);
    });

    it('refuses two ways of saying when', async () => {
        const i = add({ strings: { at: '09:00' } });
        await command.execute(i);

        expect(said(i)).toMatch(/not both/);
        expect(createTask).not.toHaveBeenCalled();
    });

    it('refuses neither', async () => {
        const i = interaction({ sub: 'add', strings: { instruction: 'do it' }, integers: {} });
        await command.execute(i);

        expect(said(i)).toMatch(/Say when/);
        expect(createTask).not.toHaveBeenCalled();
    });

    it('reads an absolute time in the server\'s timezone', async () => {
        Guild.findOne.mockReturnValue({ lean: async () => ({ ai: { dailyDigest: { timezone: 'America/New_York' } } }) });
        const i = interaction({ sub: 'add', strings: { instruction: 'do it', at: '09:00' }, integers: {} });

        await command.execute(i);

        const { fireAt, timezone } = createTask.mock.calls[0][0];
        // The task outlives the conversation, so the timezone is the server's
        // rather than whoever happened to type the command.
        expect(timezone).toBe('America/New_York');
        expect(fireAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('says so rather than guessing when the time is unreadable', async () => {
        const i = interaction({ sub: 'add', strings: { instruction: 'do it', at: 'half past soon' }, integers: {} });
        await command.execute(i);

        expect(said(i)).toMatch(/Couldn't read/);
        expect(createTask).not.toHaveBeenCalled();
    });

    it('refuses a first run further out than a task may be scheduled', async () => {
        const i = add({ integers: { in_minutes: MAX_TASK_DELAY_MINUTES + 60 } });
        await command.execute(i);

        expect(said(i)).toMatch(/at most a year/);
        expect(createTask).not.toHaveBeenCalled();
    });

    it('passes the service\'s refusal straight through', async () => {
        // The caps live in one place, so the command shows what they said
        // rather than re-deriving them.
        createTask.mockResolvedValue({ error: 'This server already has the maximum of 20 scheduled tasks.' });
        const i = add();

        await command.execute(i);

        expect(said(i)).toMatch(/maximum of 20/);
    });
});

describe('/ai schedule list and remove', () => {
    const task = (over = {}) => ({
        _id: { toString: () => 'aaaabbbbcccc123456' },
        channelId: 'c1', prompt: 'recap', repeat: 'daily', enabled: true,
        fireAt: new Date(Date.now() + 60_000), lastError: null, ...over,
    });

    it('says so when there is nothing scheduled', async () => {
        const i = interaction({ sub: 'list' });
        await command.execute(i);
        expect(said(i)).toMatch(/No scheduled AI tasks/);
    });

    it('shows a disabled task and why the runner gave up on it', async () => {
        ScheduledTask.find.mockReturnValue({
            sort: () => ({ limit: async () => [task({ enabled: false, lastError: 'channel is gone' })] })
        });
        const i = interaction({ sub: 'list' });

        await command.execute(i);

        const description = i.replies[0].embeds[0].data.description;
        expect(description).toMatch(/\*\*off\*\*/);
        expect(description).toMatch(/channel is gone/);
    });

    it('removes the task the short id names', async () => {
        ScheduledTask.find.mockResolvedValue([task()]);
        const i = interaction({ sub: 'remove', strings: { id: '123456' } });

        await command.execute(i);

        expect(ScheduledTask.deleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
        expect(said(i)).toMatch(/Removed/);
    });

    it('cannot be pointed at another server\'s task', async () => {
        // The lookup is scoped to this guild, so an id from elsewhere simply
        // is not there to match.
        ScheduledTask.find.mockResolvedValue([]);
        const i = interaction({ sub: 'remove', strings: { id: '999999' } });

        await command.execute(i);

        expect(ScheduledTask.find).toHaveBeenCalledWith({ guildId: 'g1' });
        expect(ScheduledTask.deleteOne).not.toHaveBeenCalled();
        expect(said(i)).toMatch(/No scheduled task/);
    });

    it('refuses rather than guessing when a short id matches twice', async () => {
        ScheduledTask.find.mockResolvedValue([task(), task()]);
        const i = interaction({ sub: 'remove', strings: { id: '123456' } });

        await command.execute(i);

        expect(ScheduledTask.deleteOne).not.toHaveBeenCalled();
        expect(said(i)).toMatch(/more than one/);
    });
});

describe('/ai task', () => {
    const start = (over = {}) => interaction({ group: null, sub: 'task', strings: { prompt: 'diff the feeds' }, ...over });

    it('acknowledges and hands the run off rather than waiting for it', async () => {
        const i = start();
        await command.execute(i);

        // The run has a wall clock measured in minutes and an interaction token
        // has fifteen, so the command must not be what is waiting.
        expect(said(i)).toMatch(/post the result/);
        expect(runDeepTask).toHaveBeenCalledWith(expect.objectContaining({
            guild: i.guild, channel: i.channel, user: i.user, prompt: 'diff the feeds',
        }));
    });

    it('shows the refusal without posting anything into the channel', async () => {
        refuseTask.mockReturnValue('Deep task mode is switched off on this server.');
        const i = start();

        await command.execute(i);

        expect(said(i)).toMatch(/switched off/);
        expect(runDeepTask).not.toHaveBeenCalled();
    });

    it('needs no Manage Server — a task is something anyone may ask for', async () => {
        const i = start({ manageGuild: false });
        await command.execute(i);

        expect(runDeepTask).toHaveBeenCalled();
    });

    it('survives a detached run that throws anyway', async () => {
        runDeepTask.mockRejectedValue(new Error('unforeseen'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(command.execute(start())).resolves.toBeUndefined();
        // Give the detached promise's catch a turn to run.
        await new Promise(resolve => setImmediate(resolve));

        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});
