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

function fakeMessage({ moderator = false } = {}) {
    const logChannel = { send: jest.fn(async () => ({ id: 'log1' })) };
    return {
        author: { id: 'u1' },
        member: { permissions: { has: perm => moderator && (perm === 'ModerateMembers' || perm === 'ManageGuild') } },
        guild: { id: 'g1', channels: { cache: { get: jest.fn(() => logChannel) } } },
        channel: { id: 'c1', send: jest.fn(async () => ({ id: 'm1' })) },
        __logChannel: logChannel,
    };
}

const toolNamed = (tools, name) => tools.find(tool => tool.name === name);

beforeEach(() => {
    jest.clearAllMocks();
    Reminder.countDocuments.mockResolvedValue(0);
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

    // Memory is the one that outlives the conversation, so it is the one that
    // asks first — through the same buttons a writing MCP tool goes through.
    test('only the one that writes durable state needs approving', () => {
        const tools = buildBotTools(fakeMessage({ moderator: true }));
        expect(tools.filter(tool => tool.confirm).map(tool => tool.name)).toEqual(['save_memory']);
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
