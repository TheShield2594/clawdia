'use strict';

// The in-channel actions as tools (#832), and the memory the model can write
// (#833).
//
// These used to travel as a line of text the model appended to its reply —
// `ACTION:{"type":"create_reminder",…}` — with no schema, one action per turn,
// and a malformed payload silently doing nothing while the model went on
// telling the user their reminder was set. As tools they answer in words the
// model has to read, and they inherit the approval prompt and the turn budget
// from the MCP toolkit they now ride in.

jest.mock('../src/models/Reminder', () => ({ countDocuments: jest.fn(async () => 0), create: jest.fn(async () => ({})) }));
jest.mock('../src/models/Poll', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(async () => null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/ScheduledTask', () => ({
    countDocuments: jest.fn(async () => 0),
    create: jest.fn(async doc => ({ _id: 'abcdef123456', ...doc })),
}));
jest.mock('../src/views/pollView', () => ({
    buildPollEmbed: jest.fn(() => ({ embed: true })),
    buildPollRows: jest.fn(() => [{ row: true }]),
}));

const Reminder = require('../src/models/Reminder');
const Poll = require('../src/models/Poll');
const Guild = require('../src/models/Guild');
const User = require('../src/models/User');

const { buildBotTools, BOT_SERVER } = require('../src/services/ai/botTools');
const { prepareMcpToolkit, TURN_BUDGET_MS } = require('../src/services/ai/mcp/toolkit');
const { MEMORY_CAP, MAX_MEMORY_LENGTH } = require('../src/utils/memoryLimits');
const { MAX_OPEN_REMINDERS } = require('../src/utils/reminderLimits');
const ScheduledTask = require('../src/models/ScheduledTask');
const { MAX_TASKS_PER_USER, MAX_TASK_PROMPT_LENGTH } = require('../src/utils/scheduledTaskLimits');

function fakeMessage({ moderator = false, manageGuild = moderator } = {}) {
    const logChannel = { send: jest.fn(async () => ({ id: 'log1' })) };
    return {
        author: { id: 'u1' },
        member: {
            permissions: {
                has: perm => (perm === 'ManageGuild' ? manageGuild : moderator && perm === 'ModerateMembers')
            }
        },
        guild: { id: 'g1', channels: { cache: { get: jest.fn(() => logChannel) } } },
        channel: { id: 'c1', send: jest.fn(async () => ({ id: 'm1' })) },
        __logChannel: logChannel,
    };
}

const toolNamed = (tools, name) => tools.find(tool => tool.name === name);

beforeEach(() => {
    jest.clearAllMocks();
    Reminder.countDocuments.mockResolvedValue(0);
    ScheduledTask.countDocuments.mockResolvedValue(0);
    Guild.findOne.mockResolvedValue({ moderation: { logChannelId: 'log-channel' } });
    User.findOneAndUpdate.mockResolvedValue({ userId: 'u1' });
    User.findOne.mockReturnValue({ lean: async () => ({ pinnedMemories: [] }) });
});

describe('which tools a turn is offered', () => {
    test('none at all when the guild has actions switched off', () => {
        expect(buildBotTools(fakeMessage(), { enabled: false })).toEqual([]);
    });

    test('the three anyone can use', () => {
        const names = buildBotTools(fakeMessage()).map(tool => tool.name);
        expect(names).toEqual(['create_poll', 'create_reminder', 'save_memory']);
    });

    // `/ai schedule add` is behind Manage Server, so the tool that does the
    // same thing has to be too: a standing task spends the server's budget on
    // a cadence, and the approval prompt is answerable by whoever asked for the
    // call — it is not a second pair of eyes.
    test('and scheduling only for someone who could set one up from the command', () => {
        expect(buildBotTools(fakeMessage()).map(tool => tool.name)).not.toContain('schedule_task');
        expect(buildBotTools(fakeMessage({ manageGuild: true })).map(tool => tool.name))
            .toContain('schedule_task');
    });

    test('a moderator without Manage Server gets the mod tool but not scheduling', () => {
        const names = buildBotTools(fakeMessage({ moderator: true, manageGuild: false })).map(tool => tool.name);
        expect(names).toContain('suggest_mod_action');
        expect(names).not.toContain('schedule_task');
    });

    // Offering a moderator-only tool to someone who cannot use it spends schema
    // on a refusal. The executor checks the same permission again anyway.
    test('and the moderator one only for a moderator', () => {
        const names = buildBotTools(fakeMessage({ moderator: true })).map(tool => tool.name);
        expect(names).toContain('suggest_mod_action');
    });

    test('every one of them declares a schema and says it writes', () => {
        for (const tool of buildBotTools(fakeMessage({ moderator: true }))) {
            expect(tool.inputSchema.type).toBe('object');
            expect(Object.keys(tool.inputSchema.properties).length).toBeGreaterThan(0);
            expect(tool.inputSchema.required.length).toBeGreaterThan(0);
            expect(tool.annotations.readOnlyHint).toBe(false);
            expect(tool.serverName).toBe(BOT_SERVER);
        }
    });

    // These two are the ones whose effect outlives the conversation — a memory
    // read back into every later reply, and a standing instruction that spends
    // the guild's budget on a cadence — so they are the ones that ask first,
    // through the same buttons a writing MCP tool goes through.
    test('only the ones that write durable state need approving', () => {
        const tools = buildBotTools(fakeMessage({ moderator: true, manageGuild: true }));
        expect(tools.filter(tool => tool.confirm).map(tool => tool.name))
            .toEqual(['save_memory', 'schedule_task']);
    });
});

describe('what each tool does', () => {
    const run = (name, args, options) => {
        const message = fakeMessage(options);
        const tool = toolNamed(buildBotTools(message, { enabled: true }), name);
        return tool.run(args).then(text => ({ text, message }));
    };

    test('a reminder is created, and the model is handed the timestamp to quote', async () => {
        const { text, message } = await run('create_reminder', { text: 'stretch', delayMinutes: 30 });

        expect(Reminder.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1', guildId: 'g1', channelId: 'c1', message: 'stretch', completed: false,
        }));
        const { remindAt } = Reminder.create.mock.calls[0][0];
        expect(Math.round((remindAt.getTime() - Date.now()) / 60000)).toBe(30);
        expect(text).toMatch(/<t:\d+:F>/);
        // The model is about to say this in its own reply; a second message in
        // the channel would say it twice.
        expect(message.channel.send).not.toHaveBeenCalled();
    });

    // The failure the text protocol could not report: the model was told
    // nothing, so it told the user the reminder was set.
    test('a refused reminder says so in words the model has to read', async () => {
        Reminder.countDocuments.mockResolvedValue(MAX_OPEN_REMINDERS);

        const { text } = await run('create_reminder', { text: 'stretch', delayMinutes: 30 });

        expect(Reminder.create).not.toHaveBeenCalled();
        expect(text).toMatch(new RegExp(`maximum of ${MAX_OPEN_REMINDERS} open reminders`));
    });

    // The heavy sibling of create_reminder: a reminder replays text somebody
    // already wrote, and this wakes the model up on a cadence to do work that
    // costs the guild a provider call each time.
    test('a scheduled task is created against the guild and the person who asked', async () => {
        const { text } = await run('schedule_task', {
            instruction: 'Recap #announcements', delayMinutes: 60, repeat: 'weekly'
        }, { manageGuild: true });

        expect(ScheduledTask.create).toHaveBeenCalledWith(expect.objectContaining({
            guildId: 'g1', channelId: 'c1', createdBy: 'u1',
            kind: 'ai_prompt', prompt: 'Recap #announcements', repeat: 'weekly',
        }));
        const { fireAt } = ScheduledTask.create.mock.calls[0][0];
        expect(Math.round((fireAt.getTime() - Date.now()) / 60000)).toBe(60);
        expect(text).toMatch(/<t:\d+:F>/);
        expect(text).toMatch(/\/ai schedule/);
    });

    test('"none" means run it once, not a cadence called none', async () => {
        await run('schedule_task', { instruction: 'one-off', delayMinutes: 5, repeat: 'none' }, { manageGuild: true });
        expect(ScheduledTask.create).toHaveBeenCalledWith(expect.objectContaining({ repeat: null }));
    });

    test('the model\'s route is held to the same caps as the slash command', async () => {
        ScheduledTask.countDocuments
            .mockResolvedValueOnce(0)                     // guild
            .mockResolvedValueOnce(MAX_TASKS_PER_USER);   // user

        const { text } = await run('schedule_task', { instruction: 'more', delayMinutes: 5, repeat: 'daily' }, { manageGuild: true });

        expect(ScheduledTask.create).not.toHaveBeenCalled();
        expect(text).toMatch(new RegExp(`maximum of ${MAX_TASKS_PER_USER}`));
    });

    test('a task with no first-run time is refused rather than guessed at', async () => {
        const { text } = await run('schedule_task', { instruction: 'when?', repeat: 'daily' }, { manageGuild: true });

        expect(ScheduledTask.create).not.toHaveBeenCalled();
        expect(text).toMatch(/how many minutes/);
    });

    test('an over-long instruction is refused, not truncated', async () => {
        // Truncating leaves a standing instruction whose second half is missing,
        // running every day, with nobody reading it.
        const { text } = await run('schedule_task', {
            instruction: 'x'.repeat(MAX_TASK_PROMPT_LENGTH + 1), delayMinutes: 5, repeat: 'daily'
        }, { manageGuild: true });

        expect(ScheduledTask.create).not.toHaveBeenCalled();
        expect(text).toMatch(new RegExp(`${MAX_TASK_PROMPT_LENGTH} characters`));
    });

    test('the executor refuses scheduling again, even if the tool were reached', async () => {
        // The tool is not offered without Manage Server; this is the second
        // check behind it, the same belt and braces suggest_mod_action has.
        const { runAction } = require('../src/services/ai/actions');
        const message = fakeMessage();

        const text = await runAction(
            { type: 'schedule_task', instruction: 'nightly recap', delayMinutes: 60, repeat: 'daily' },
            message
        );

        expect(text).toMatch(/only someone with Manage Server/);
        expect(ScheduledTask.create).not.toHaveBeenCalled();
    });

    test('a poll is posted and recorded', async () => {
        const { text, message } = await run('create_poll', { question: 'Pizza?', options: ['yes', 'no'] });

        expect(message.channel.send).toHaveBeenCalledWith({ embeds: [{ embed: true }], components: [{ row: true }] });
        expect(Poll.create).toHaveBeenCalledWith(expect.objectContaining({ question: 'Pizza?', options: ['yes', 'no'] }));
        expect(text).toMatch(/poll is now in the channel/);
    });

    // A model that ignores the schema, or an ACTION block that never had one,
    // can send `options` as a string. `.filter` on that is a TypeError, which
    // turned the refusal the caller expects into a failure report.
    test('a poll whose options are not a list is refused, not a crash', async () => {
        const { text, message } = await run('create_poll', { question: 'Pizza?', options: 'yes,no' });

        expect(message.channel.send).not.toHaveBeenCalled();
        expect(Poll.create).not.toHaveBeenCalled();
        expect(text).toMatch(/at least two options/);
    });

    test('a poll with one option is refused rather than posted empty', async () => {
        const { text, message } = await run('create_poll', { question: 'Pizza?', options: ['yes'] });

        expect(message.channel.send).not.toHaveBeenCalled();
        expect(Poll.create).not.toHaveBeenCalled();
        expect(text).toMatch(/at least two options/);
    });

    test('a mod suggestion reaches the log channel', async () => {
        const { text, message } = await run('suggest_mod_action', { suggestion: 'watch #general' }, { moderator: true });

        // Model-authored text reaching a channel: it goes out with the mention
        // policy, or a model talked into typing `@everyone` pings the mod log.
        expect(message.__logChannel.send).toHaveBeenCalledWith({
            content: expect.stringContaining('watch #general'),
            allowedMentions: { parse: [] },
        });
        expect(text).toMatch(/posted to the moderation log/);
    });

    test('and is refused when the server has no log channel', async () => {
        Guild.findOne.mockResolvedValue({ moderation: {} });

        const { text, message } = await run('suggest_mod_action', { suggestion: 'watch #general' }, { moderator: true });

        expect(message.__logChannel.send).not.toHaveBeenCalled();
        expect(text).toMatch(/no moderation log channel/);
    });
});

describe('save_memory', () => {
    const save = (content, message = fakeMessage()) =>
        toolNamed(buildBotTools(message), 'save_memory').run({ content });

    test('writes the memory and tells the model where it will show up', async () => {
        const text = await save('Prefers to be called Sam');

        const [filter, update] = User.findOneAndUpdate.mock.calls[0];
        expect(update.$push.pinnedMemories).toMatchObject({ content: 'Prefers to be called Sam', channelId: 'c1' });
        // The cap is part of the write, not a read followed by a write: two
        // turns saving at once must not both find room and take it.
        expect(filter[`pinnedMemories.${MEMORY_CAP - 1}`]).toEqual({ $exists: false });
        expect(text).toMatch(/^Saved\./);
    });

    test('will not stack the same memory twice', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        User.findOne.mockReturnValue({ lean: async () => ({ pinnedMemories: [{ content: 'Prefers to be called Sam' }] }) });

        const text = await save('Prefers to be called Sam');

        expect(text).toMatch(/already one of their saved memories/);
        // The write refuses it too, rather than relying on the read that
        // explains it: a model repeating itself across a conversation would
        // otherwise fill the cap with one fact.
        expect(User.findOneAndUpdate.mock.calls[0][0]['pinnedMemories.content'])
            .toEqual({ $ne: 'Prefers to be called Sam' });
    });

    test('says how to make room when the cap is full', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        User.findOne.mockReturnValue({
            lean: async () => ({ pinnedMemories: Array.from({ length: MEMORY_CAP }, (_, i) => ({ content: `m${i}` })) }),
        });

        const text = await save('one more thing');

        expect(text).toMatch(new RegExp(`maximum of ${MEMORY_CAP} saved memories`));
        expect(text).toMatch(/\/ai memories/);
    });

    test('does not create a profile for someone who has never used the bot', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        User.findOne.mockReturnValue({ lean: async () => null });

        const text = await save('something');

        expect(User.findOneAndUpdate.mock.calls[0][2]).toMatchObject({ upsert: false });
        expect(text).toMatch(/no profile on this server yet/);
    });

    test('saves nothing for an empty memory', async () => {
        const text = await save('   ');
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(text).toMatch(/was empty/);
    });

    test('truncates a memory too long to inject into every future prompt', async () => {
        await save('x'.repeat(MAX_MEMORY_LENGTH + 50));

        const { content } = User.findOneAndUpdate.mock.calls[0][1].$push.pinnedMemories;
        expect(content).toHaveLength(MAX_MEMORY_LENGTH + 1); // the ellipsis
        expect(content.endsWith('…')).toBe(true);
    });
});

describe('riding in the MCP toolkit', () => {
    const toolkitWith = (botTools, options = {}) => prepareMcpToolkit([], { botTools, ...options });

    test('a guild with no MCP servers still gets a toolkit for its actions', async () => {
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()));

        expect(toolkit.definitions.map(d => d.name)).toEqual(['create_poll', 'create_reminder', 'save_memory']);
        // Bare names, like the load_tools meta-tool: these belong to the bot, and
        // every discovered tool's name carries a `server__tool` double underscore.
        expect(toolkit.definitions.every(d => !d.name.includes('__'))).toBe(true);
    });

    test('and a request with neither still takes the plain path', async () => {
        expect(await prepareMcpToolkit([], { botTools: [] })).toBeNull();
    });

    // `mcpServers: []` means "this guild added none", not "reach none":
    // `resolveMcpServers` merges the guild's list with the operator's config
    // file, so an empty guild list still resolves every server the operator
    // configured. A caller that must not reach any — the DM narrator, where a
    // tool result would be untrusted text arriving mid-story — has to say so.
    //
    // Loaded in isolation with the config module mocked, because the thing
    // being pinned is that resolution is *skipped*, and a toolkit built in an
    // environment with no operator config looks identical either way.
    test('botToolsOnly skips server resolution rather than passing an empty list', async () => {
        await jest.isolateModulesAsync(async () => {
            const resolveMcpServers = jest.fn(() => [
                { name: 'operator-notes', url: 'https://example.invalid/mcp' }
            ]);
            jest.doMock('../src/config/mcpServers', () => ({
                ...jest.requireActual('../src/config/mcpServers'),
                resolveMcpServers,
            }));

            const { prepareMcpToolkit: prepare } = require('../src/services/ai/mcp/toolkit');
            const tools = buildBotTools(fakeMessage());

            const only = await prepare([], { botTools: tools, botToolsOnly: true });
            expect(resolveMcpServers).not.toHaveBeenCalled();
            expect(only.servers).toEqual([]);
            expect(only.definitions.every(d => !d.name.includes('__'))).toBe(true);

            // And without the flag an empty guild list still reaches for the
            // operator's servers — which is the whole reason the flag exists.
            // What happens when it tries to dial one is not the point here, so
            // the attempt is allowed to fail.
            await prepare([], { botTools: tools }).catch(() => {});
            expect(resolveMcpServers).toHaveBeenCalledWith([]);
        });
    });

    test('a call runs the tool and hands back what it said', async () => {
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()));

        const result = await toolkit.call('create_reminder', { text: 'stretch', delayMinutes: 5 });

        expect(Reminder.create).toHaveBeenCalled();
        expect(result).toMatch(/Reminder set for/);
        // Unlabelled: the label marks text a third party wrote, and this is the
        // bot answering itself.
        expect(result).not.toMatch(/reference data/);
    });

    test('a tool that throws is reported to the model, not to the user', async () => {
        Reminder.create.mockRejectedValue(new Error('mongo is down'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()));

        const result = await toolkit.call('create_reminder', { text: 'stretch', delayMinutes: 5 });

        expect(result).toMatch(/could not be completed: mongo is down/);
        expect(result).toMatch(/it did not happen/);
        warn.mockRestore();
    });

    test('the approval prompt stands in front of save_memory', async () => {
        const confirmTool = jest.fn(async () => ({ approved: false }));
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()), { confirmTool });

        const result = await toolkit.call('save_memory', { content: 'remember this' });

        expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({ tool: 'save_memory' }));
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(result).toMatch(/declined/);
    });

    test('and lets it through once somebody clicks', async () => {
        const confirmTool = jest.fn(async () => ({ approved: true }));
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()), { confirmTool });

        await toolkit.call('save_memory', { content: 'remember this' });

        expect(User.findOneAndUpdate).toHaveBeenCalled();
    });

    test('a poll needs no approval, the way it never did', async () => {
        const confirmTool = jest.fn(async () => ({ approved: true }));
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()), { confirmTool });

        await toolkit.call('create_poll', { question: 'Pizza?', options: ['yes', 'no'] });

        expect(confirmTool).not.toHaveBeenCalled();
        expect(Poll.create).toHaveBeenCalled();
    });

    test('the user\'s tool allowance bounds them like any other call', async () => {
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()), { toolBudget: () => false });

        const result = await toolkit.call('create_reminder', { text: 'stretch', delayMinutes: 5 });

        expect(Reminder.create).not.toHaveBeenCalled();
        expect(result).toMatch(/used up the tool calls/);
    });

    test('the activity ledger sees them under the bot\'s own name', async () => {
        const events = [];
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()), { onToolEvent: e => events.push(e) });

        await toolkit.call('create_poll', { question: 'Pizza?', options: ['yes', 'no'] });

        expect(events.map(e => e.type)).toEqual(['start', 'end']);
        expect(events[1]).toMatchObject({ server: BOT_SERVER, tool: 'create_poll', ok: true });
    });

    // The turn budget bounds the wait on somebody else's HTTP request; a bot
    // tool is local, but a stalled Discord send would hold the reply open just
    // as long. What it cannot do is call the write back, so the wording says the
    // turn stopped waiting rather than claiming the action failed.
    test('a run that outlives the turn budget is reported as unconfirmed, not failed', async () => {
        jest.useFakeTimers();
        try {
            const message = fakeMessage();
            const stuck = toolNamed(buildBotTools(message), 'create_poll');
            stuck.run = () => new Promise(() => {});
            const toolkit = await toolkitWith([stuck]);

            const call = toolkit.call('create_poll', { question: 'Pizza?', options: ['yes', 'no'] });
            await jest.advanceTimersByTimeAsync(TURN_BUDGET_MS + 1000);

            const result = await call;
            expect(result).toMatch(/ran out of time/);
            expect(result).toMatch(/may still go through/);
            expect(result).not.toMatch(/did not happen/);
        } finally {
            jest.useRealTimers();
        }
    });

    test('and one that finishes in time is unaffected by the clock', async () => {
        jest.useFakeTimers();
        try {
            const toolkit = await toolkitWith(buildBotTools(fakeMessage()));
            const result = await toolkit.call('create_poll', { question: 'Pizza?', options: ['yes', 'no'] });

            expect(Poll.create).toHaveBeenCalled();
            expect(result).toMatch(/poll is now in the channel/);
            // The losing timer is cleared, so nothing is left holding the loop.
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('a name the model invented is answered, not thrown', async () => {
        const toolkit = await toolkitWith(buildBotTools(fakeMessage()));
        expect(await toolkit.call('delete_everything', {})).toMatch(/No tool named/);
    });
});
