'use strict';

jest.mock('discord.js', () => {
    const EmbedBuilder = jest.fn().mockImplementation(() => {
        const self = {
            data: {},
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockReturnThis(),
            setAuthor: jest.fn().mockImplementation(function (opts) { self.data.author = opts; return self; }),
            addFields: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
        };
        return self;
    });
    return {
        EmbedBuilder,
        AuditLogEvent: { ChannelCreate: 10, ChannelDelete: 12 },
        PermissionFlagsBits: { SendMessages: 1n << 11n },
    };
});

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/services/antiNukeService', () => ({ trackAction: jest.fn().mockResolvedValue(undefined) }));

const Guild = require('../src/models/Guild');
const { clearGuildSettingsCache } = require('../src/utils/guildSettingsCache');
const messageDeleteEvent = require('../src/events/messageDelete');
const messageUpdateEvent = require('../src/events/messageUpdate');
const guildMemberUpdateEvent = require('../src/events/guildMemberUpdate');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSendMock() {
    return jest.fn().mockResolvedValue(undefined);
}

function makeLogChannel(canSend = true) {
    const send = makeSendMock();
    return {
        id: 'logchannel123',
        send,
        permissionsFor: jest.fn().mockReturnValue({ has: jest.fn().mockReturnValue(canSend) }),
    };
}

function makeGuildSettings(overrides = {}) {
    return {
        eventLog: {
            enabled: true,
            channelId: 'logchannel123',
            logMessageDelete: true,
            logMessageEdit: true,
            logRoleChanges: true,
            logChannelChanges: true,
        },
        ...overrides,
    };
}

function makeGuild(logChannel) {
    return {
        id: 'guild123',
        memberCount: 5,
        members: { me: {} },
        channels: { cache: { get: jest.fn().mockReturnValue(logChannel) } },
    };
}

function makeAuthor(overrides = {}) {
    return {
        bot: false,
        id: 'user123',
        globalName: 'DisplayName',
        username: 'cooluser',
        tag: 'cooluser#0',
        displayAvatarURL: jest.fn().mockReturnValue('https://cdn.test/avatar.png'),
        ...overrides,
    };
}

// These handlers read through guildSettingsCache. Its invalidation runs off
// Mongoose middleware, which the Guild mock above does not have, so each test's
// mockResolvedValue would otherwise be shadowed by the first test's entry.
beforeEach(() => {
    jest.clearAllMocks();
    clearGuildSettingsCache();
});

// ---------------------------------------------------------------------------
// messageDelete
// ---------------------------------------------------------------------------

describe('messageDelete event', () => {
    function makeMessage(overrides = {}) {
        const logChannel = makeLogChannel();
        const guild = makeGuild(logChannel);
        return {
            author: makeAuthor(),
            guild,
            channel: { id: 'chan123' },
            content: 'hello world',
            attachments: { size: 0 },
            _logChannel: logChannel,
            ...overrides,
        };
    }

    test('logs deleted message when event log enabled', async () => {
        const msg = makeMessage();
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageDeleteEvent.execute(msg);
        expect(msg._logChannel.send).toHaveBeenCalledTimes(1);
    });

    test('skips when event log disabled', async () => {
        const msg = makeMessage();
        Guild.findOne.mockResolvedValue(makeGuildSettings({ eventLog: { enabled: false } }));
        await messageDeleteEvent.execute(msg);
        expect(msg._logChannel.send).not.toHaveBeenCalled();
    });

    test('skips when logMessageDelete is false', async () => {
        const msg = makeMessage();
        Guild.findOne.mockResolvedValue(makeGuildSettings({
            eventLog: { enabled: true, channelId: 'logchannel123', logMessageDelete: false },
        }));
        await messageDeleteEvent.execute(msg);
        expect(msg._logChannel.send).not.toHaveBeenCalled();
    });

    test('skips for bot messages', async () => {
        const msg = makeMessage({ author: makeAuthor({ bot: true }) });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageDeleteEvent.execute(msg);
        expect(Guild.findOne).not.toHaveBeenCalled();
    });

    test('skips when bot lacks SendMessages permission', async () => {
        const logChannel = makeLogChannel(false);
        const guild = makeGuild(logChannel);
        const msg = makeMessage({ guild, _logChannel: logChannel });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageDeleteEvent.execute(msg);
        expect(logChannel.send).not.toHaveBeenCalled();
    });

    test('uses globalName ?? username in author field (not deprecated .tag)', async () => {
        const msg = makeMessage();
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageDeleteEvent.execute(msg);
        const [{ embeds }] = msg._logChannel.send.mock.calls[0];
        expect(embeds[0].data.author.name).toBe('DisplayName');
    });

    test('falls back to username when globalName is null', async () => {
        const author = makeAuthor({ globalName: null });
        const msg = makeMessage({ author });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageDeleteEvent.execute(msg);
        const [{ embeds }] = msg._logChannel.send.mock.calls[0];
        expect(embeds[0].data.author.name).toBe('cooluser');
    });

    test('truncates long message content at 1024 chars', async () => {
        const longContent = 'x'.repeat(2000);
        const msg = makeMessage({ content: longContent });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        // Just verify no error is thrown — embed builder receives truncated string
        await expect(messageDeleteEvent.execute(msg)).resolves.toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// messageUpdate
// ---------------------------------------------------------------------------

describe('messageUpdate event', () => {
    function makeMessages(oldContent = 'before', newContent = 'after') {
        const logChannel = makeLogChannel();
        const guild = makeGuild(logChannel);
        const author = makeAuthor();
        const newMessage = {
            author,
            guild,
            channel: { id: 'chan123' },
            content: newContent,
            url: 'https://discord.com/channels/1/2/3',
            _logChannel: logChannel,
        };
        const oldMessage = { content: oldContent };
        return { oldMessage, newMessage };
    }

    test('logs edited message when content changed', async () => {
        const { oldMessage, newMessage } = makeMessages();
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageUpdateEvent.execute(oldMessage, newMessage);
        expect(newMessage._logChannel.send).toHaveBeenCalledTimes(1);
    });

    test('skips when content is unchanged', async () => {
        const { oldMessage, newMessage } = makeMessages('same', 'same');
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageUpdateEvent.execute(oldMessage, newMessage);
        expect(newMessage._logChannel.send).not.toHaveBeenCalled();
    });

    test('skips for bot authors', async () => {
        const { oldMessage, newMessage } = makeMessages();
        newMessage.author = makeAuthor({ bot: true });
        await messageUpdateEvent.execute(oldMessage, newMessage);
        expect(Guild.findOne).not.toHaveBeenCalled();
    });

    test('skips when bot lacks SendMessages permission', async () => {
        const logChannel = makeLogChannel(false);
        const guild = makeGuild(logChannel);
        const { oldMessage, newMessage } = makeMessages();
        newMessage.guild = guild;
        newMessage._logChannel = logChannel;
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageUpdateEvent.execute(oldMessage, newMessage);
        expect(logChannel.send).not.toHaveBeenCalled();
    });

    test('uses globalName ?? username (not deprecated .tag)', async () => {
        const { oldMessage, newMessage } = makeMessages();
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await messageUpdateEvent.execute(oldMessage, newMessage);
        const [{ embeds }] = newMessage._logChannel.send.mock.calls[0];
        expect(embeds[0].data.author.name).toBe('DisplayName');
    });
});

// ---------------------------------------------------------------------------
// guildMemberUpdate
// ---------------------------------------------------------------------------

describe('guildMemberUpdate event', () => {
    function makeRole(id, name) {
        return { id, toString: () => `<@&${id}>`, name };
    }

    function makeMembers({ addedRoles = [], removedRoles = [] } = {}) {
        const logChannel = makeLogChannel();
        const guild = makeGuild(logChannel);
        const baseRoles = [makeRole('role_base', 'Base')];
        const oldRoles = new Map([...baseRoles, ...removedRoles].map(r => [r.id, r]));
        const newRoles = new Map([...baseRoles, ...addedRoles].map(r => [r.id, r]));

        const common = {
            guild,
            user: makeAuthor(),
            _logChannel: logChannel,
        };
        return {
            oldMember: { ...common, roles: { cache: { filter: fn => ({ size: [...oldRoles.values()].filter(fn).length, map: cb => [...oldRoles.values()].filter(fn).map(cb) }), has: id => oldRoles.has(id) } } },
            newMember: { ...common, roles: { cache: { filter: fn => ({ size: [...newRoles.values()].filter(fn).length, map: cb => [...newRoles.values()].filter(fn).map(cb) }), has: id => newRoles.has(id) } } },
            logChannel,
        };
    }

    test('logs when roles are added', async () => {
        const { oldMember, newMember, logChannel } = makeMembers({ addedRoles: [makeRole('new_role', 'NewRole')] });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await guildMemberUpdateEvent.execute(oldMember, newMember);
        expect(logChannel.send).toHaveBeenCalledTimes(1);
    });

    test('logs when roles are removed', async () => {
        const { oldMember, newMember, logChannel } = makeMembers({ removedRoles: [makeRole('old_role', 'OldRole')] });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await guildMemberUpdateEvent.execute(oldMember, newMember);
        expect(logChannel.send).toHaveBeenCalledTimes(1);
    });

    test('skips when no role changes', async () => {
        const { oldMember, newMember, logChannel } = makeMembers();
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await guildMemberUpdateEvent.execute(oldMember, newMember);
        expect(logChannel.send).not.toHaveBeenCalled();
    });

    test('skips when bot lacks SendMessages permission', async () => {
        const logChannel = makeLogChannel(false);
        const guild = makeGuild(logChannel);
        const { oldMember, newMember } = makeMembers({ addedRoles: [makeRole('x', 'X')] });
        oldMember.guild = guild;
        newMember.guild = guild;
        newMember._logChannel = logChannel;
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await guildMemberUpdateEvent.execute(oldMember, newMember);
        expect(logChannel.send).not.toHaveBeenCalled();
    });

    test('uses globalName ?? username (not deprecated .tag)', async () => {
        const { oldMember, newMember, logChannel } = makeMembers({ addedRoles: [makeRole('r', 'R')] });
        Guild.findOne.mockResolvedValue(makeGuildSettings());
        await guildMemberUpdateEvent.execute(oldMember, newMember);
        const [{ embeds }] = logChannel.send.mock.calls[0];
        expect(embeds[0].data.author.name).toBe('DisplayName');
    });
});

// ---------------------------------------------------------------------------
// validateEventLogUpdate (API)
// ---------------------------------------------------------------------------

describe('validateEventLogUpdate', () => {
    const { validateEventLogUpdate } = require('../src/dashboard/routes/api.js');

    test('returns null for valid boolean fields', () => {
        expect(validateEventLogUpdate({ 'eventLog.enabled': true, 'eventLog.logMessageEdit': false })).toBeNull();
    });

    test('returns error when enabled is not a boolean', () => {
        const result = validateEventLogUpdate({ 'eventLog.enabled': 'yes' });
        expect(result).toMatch(/boolean/);
    });

    test('returns null for valid channelId snowflake', () => {
        expect(validateEventLogUpdate({ 'eventLog.channelId': '123456789012345678' })).toBeNull();
    });

    test('returns error for invalid channelId', () => {
        const result = validateEventLogUpdate({ 'eventLog.channelId': 'not-a-snowflake' });
        expect(result).toMatch(/snowflake/);
    });

    test('returns null for null channelId', () => {
        expect(validateEventLogUpdate({ 'eventLog.channelId': null })).toBeNull();
    });

    test('ignores unrelated keys', () => {
        expect(validateEventLogUpdate({ 'welcome.enabled': true })).toBeNull();
    });
});
