'use strict';

jest.mock('discord.js', () => ({
    ChannelType: { GuildVoice: 2 },
    PermissionFlagsBits: { ManageChannels: 1n << 4n, MuteMembers: 1n << 22n, DeafenMembers: 1n << 23n },
}));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
}));

const { handleVoiceStateUpdate, checkTempVoice } = require('../src/services/tempVoiceService');
const Guild = require('../src/models/Guild');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuildSettings(overrides = {}) {
    return {
        guildId: 'guild1',
        tempVoice: {
            enabled: true,
            lobbyChannelId: 'lobby1',
            categoryId: null,
            activeChannels: [],
            channelName: "{username}'s VC",
            userLimit: 0,
            bitrate: 64,
            ...overrides,
        },
    };
}

function makeGuild({ createChannel = null, canManage = true } = {}) {
    const createdChannel = { id: 'newchan1', members: { size: 0 }, delete: jest.fn().mockResolvedValue() };
    const botMember = {
        permissionsIn: jest.fn().mockReturnValue({ has: jest.fn().mockReturnValue(canManage) }),
    };
    const guild = {
        id: 'guild1',
        members: {
            me: botMember,
            cache: { get: jest.fn() },
        },
        channels: {
            cache: { get: jest.fn() },
            create: createChannel ?? jest.fn().mockResolvedValue(createdChannel),
        },
    };
    guild._createdChannel = createdChannel;
    return guild;
}

function makeMember(username = 'testuser', displayName = 'TestUser', globalName = 'TestGlobal') {
    return {
        id: 'user1',
        user: { username, globalName, tag: 'DEPRECATED#0001' },
        displayName,
        voice: { setChannel: jest.fn().mockResolvedValue() },
    };
}

function makeNewState(guild, member, channelId) {
    return { guild, member, channelId };
}

function makeOldState(guild, channelId) {
    return { guild, channelId };
}

// ---------------------------------------------------------------------------
// Channel creation on lobby join
// ---------------------------------------------------------------------------

describe('handleVoiceStateUpdate — lobby join', () => {
    afterEach(() => jest.clearAllMocks());

    test('creates a temp channel when member joins lobby', async () => {
        const guild = makeGuild();
        const member = makeMember();
        const guildSettings = makeGuildSettings();
        Guild.findOne.mockResolvedValue(guildSettings);

        const newState = makeNewState(guild, member, 'lobby1');
        const oldState = makeOldState(guild, null);

        await handleVoiceStateUpdate(oldState, newState, {});

        expect(guild.channels.create).toHaveBeenCalledWith(
            expect.objectContaining({ type: 2 })
        );
        expect(member.voice.setChannel).toHaveBeenCalledWith(guild._createdChannel);
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'guild1' },
            { $addToSet: { 'tempVoice.activeChannels': 'newchan1' } }
        );
    });

    test('resolves {tag} using globalName, not deprecated user.tag', async () => {
        const guild = makeGuild();
        const member = makeMember('alice', 'Alice', 'AliceGlobal');
        const guildSettings = makeGuildSettings({ channelName: '{tag} channel' });
        Guild.findOne.mockResolvedValue(guildSettings);

        const newState = makeNewState(guild, member, 'lobby1');
        const oldState = makeOldState(guild, null);

        await handleVoiceStateUpdate(oldState, newState, {});

        expect(guild.channels.create).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'AliceGlobal channel' })
        );
    });

    test('resolves {username} in channel name', async () => {
        const guild = makeGuild();
        const member = makeMember('bob', 'Bob');
        const guildSettings = makeGuildSettings({ channelName: "{username}'s room" });
        Guild.findOne.mockResolvedValue(guildSettings);

        await handleVoiceStateUpdate(makeOldState(guild, null), makeNewState(guild, member, 'lobby1'), {});

        expect(guild.channels.create).toHaveBeenCalledWith(
            expect.objectContaining({ name: "bob's room" })
        );
    });

    test('does nothing when bot lacks ManageChannels', async () => {
        const guild = makeGuild({ canManage: false });
        const member = makeMember();
        Guild.findOne.mockResolvedValue(makeGuildSettings());

        await handleVoiceStateUpdate(makeOldState(guild, null), makeNewState(guild, member, 'lobby1'), {});

        expect(guild.channels.create).not.toHaveBeenCalled();
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('does nothing when tempVoice is disabled', async () => {
        const guild = makeGuild();
        const member = makeMember();
        Guild.findOne.mockResolvedValue(makeGuildSettings({ enabled: false }));

        await handleVoiceStateUpdate(makeOldState(guild, null), makeNewState(guild, member, 'lobby1'), {});

        expect(guild.channels.create).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Channel deletion on leave
// ---------------------------------------------------------------------------

describe('handleVoiceStateUpdate — channel leave', () => {
    afterEach(() => jest.clearAllMocks());

    test('deletes empty temp channel when last member leaves', async () => {
        const tempChannel = { id: 'temp1', members: { size: 0 }, delete: jest.fn().mockResolvedValue() };
        const guild = makeGuild();
        guild.channels.cache.get.mockReturnValue(tempChannel);

        const guildSettings = makeGuildSettings({ activeChannels: ['temp1'] });
        Guild.findOne.mockResolvedValue(guildSettings);

        const oldState = makeOldState(guild, 'temp1');
        const newState = { guild, member: null, channelId: null };

        await handleVoiceStateUpdate(oldState, newState, {});

        expect(tempChannel.delete).toHaveBeenCalled();
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'guild1' },
            { $pull: { 'tempVoice.activeChannels': 'temp1' } }
        );
    });

    test('does not delete temp channel when members remain', async () => {
        const tempChannel = { id: 'temp1', members: { size: 2 }, delete: jest.fn() };
        const guild = makeGuild();
        guild.channels.cache.get.mockReturnValue(tempChannel);

        Guild.findOne.mockResolvedValue(makeGuildSettings({ activeChannels: ['temp1'] }));

        const oldState = makeOldState(guild, 'temp1');
        const newState = { guild, member: null, channelId: null };

        await handleVoiceStateUpdate(oldState, newState, {});

        expect(tempChannel.delete).not.toHaveBeenCalled();
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('ignores leave from the lobby channel itself', async () => {
        const guild = makeGuild();
        Guild.findOne.mockResolvedValue(makeGuildSettings({ activeChannels: ['lobby1'] }));

        const oldState = makeOldState(guild, 'lobby1');
        const newState = { guild, member: null, channelId: null };

        await handleVoiceStateUpdate(oldState, newState, {});

        expect(Guild.updateOne).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// checkTempVoice periodic cleanup
// ---------------------------------------------------------------------------

describe('checkTempVoice', () => {
    afterEach(() => jest.clearAllMocks());

    test('deletes and removes stale channels with no members', async () => {
        const staleChannel = { id: 'stale1', members: { size: 0 }, delete: jest.fn().mockResolvedValue() };
        const guild = { channels: { cache: { get: jest.fn().mockReturnValue(staleChannel) } } };
        const client = { guilds: { cache: { get: jest.fn().mockReturnValue(guild) } } };

        Guild.find.mockResolvedValue([
            makeGuildSettings({ activeChannels: ['stale1'] }),
        ]);

        await checkTempVoice(client);

        expect(staleChannel.delete).toHaveBeenCalled();
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'guild1' },
            { $set: { 'tempVoice.activeChannels': [] } }
        );
    });

    test('keeps active channels with members', async () => {
        const activeChannel = { id: 'active1', members: { size: 3 }, delete: jest.fn() };
        const guild = { channels: { cache: { get: jest.fn().mockReturnValue(activeChannel) } } };
        const client = { guilds: { cache: { get: jest.fn().mockReturnValue(guild) } } };

        Guild.find.mockResolvedValue([
            makeGuildSettings({ activeChannels: ['active1'] }),
        ]);

        await checkTempVoice(client);

        expect(activeChannel.delete).not.toHaveBeenCalled();
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('removes ghost channel IDs not in guild cache', async () => {
        const guild = { channels: { cache: { get: jest.fn().mockReturnValue(undefined) } } };
        const client = { guilds: { cache: { get: jest.fn().mockReturnValue(guild) } } };

        Guild.find.mockResolvedValue([
            makeGuildSettings({ activeChannels: ['ghost1'] }),
        ]);

        await checkTempVoice(client);

        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'guild1' },
            { $set: { 'tempVoice.activeChannels': [] } }
        );
    });
});
