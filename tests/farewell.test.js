'use strict';

jest.mock('discord.js', () => {
    const EmbedBuilder = jest.fn().mockImplementation(() => {
        const self = {
            data: {},
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockReturnThis(),
            setDescription: jest.fn().mockImplementation(function (desc) { self.data.description = desc; return self; }),
            setThumbnail: jest.fn().mockReturnThis(),
            setAuthor: jest.fn().mockReturnThis(),
            addFields: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
        };
        return self;
    });
    return {
        EmbedBuilder,
        AuditLogEvent: { MemberKick: 20 },
        PermissionFlagsBits: { SendMessages: 1n << 11n },
    };
});

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/GuildAnalytics', () => ({ updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) }));
jest.mock('../src/services/antiNukeService', () => ({ trackAction: jest.fn().mockResolvedValue(undefined) }));

const { clearGuildSettingsCache } = require('../src/utils/guildSettingsCache');
const farewellEvent = require('../src/events/guildMemberRemove');

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

function makeMember(overrides = {}) {
    return {
        id: '111222333444555666',
        user: {
            globalName: 'DisplayName',
            username: 'cooluser',
            tag: 'cooluser#0',
            displayAvatarURL: jest.fn().mockReturnValue('https://cdn.discordapp.com/avatars/test.png'),
        },
        guild: {
            id: '999888777666555444',
            name: 'Cool Server',
            memberCount: 10,
            members: { me: {} },
            channels: { cache: { get: jest.fn() } },
        },
        joinedAt: new Date('2024-01-01'),
        joinedTimestamp: new Date('2024-01-01').getTime(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// applyVariables (tested via execute with farewell enabled)
// We extract the module-internal logic by exercising channel.send captures.
// ---------------------------------------------------------------------------

describe('farewell applyVariables', () => {
    let sendSpy;
    let member;

    beforeEach(() => {
        // guildMemberRemove reads through guildSettingsCache, whose invalidation
        // rides on Mongoose middleware the Guild mock above does not have. Without
        // this, a test's own mockResolvedValue is shadowed by the previous test's
        // cached entry for the same guild id.
        clearGuildSettingsCache();
        sendSpy = jest.fn().mockResolvedValue(undefined);

        const perms = { has: jest.fn().mockReturnValue(true) };
        const channel = { send: sendSpy, permissionsFor: jest.fn().mockReturnValue(perms) };

        member = makeMember();
        member.guild.channels.cache.get = jest.fn().mockReturnValue(channel);

        const Guild = require('../src/models/Guild');
        Guild.findOne.mockResolvedValue({
            guildId: member.guild.id,
            farewell: { enabled: true, channelId: 'ch1', message: 'Bye {user}! You were in {server}.' },
            eventLog: { enabled: false },
            constructor: { updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) },
        });
    });

    afterEach(() => jest.clearAllMocks());

    test('{user} resolves to globalName', async () => {
        await farewellEvent.execute(member, {});
        const embed = sendSpy.mock.calls[0][0].embeds[0];
        expect(embed.data.description).toContain('DisplayName');
    });

    test('{user} falls back to username when globalName is null', async () => {
        member.user.globalName = null;
        await farewellEvent.execute(member, {});
        const embed = sendSpy.mock.calls[0][0].embeds[0];
        expect(embed.data.description).toContain('cooluser');
    });

    test('{server} resolves to guild name', async () => {
        await farewellEvent.execute(member, {});
        const embed = sendSpy.mock.calls[0][0].embeds[0];
        expect(embed.data.description).toContain('Cool Server');
    });

    test('does not call channel.send when farewell is disabled', async () => {
        const Guild = require('../src/models/Guild');
        Guild.findOne.mockResolvedValue({
            guildId: member.guild.id,
            farewell: { enabled: false, channelId: 'ch1', message: 'Bye {user}!' },
            eventLog: { enabled: false },
            constructor: { updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) },
        });
        await farewellEvent.execute(member, {});
        expect(sendSpy).not.toHaveBeenCalled();
    });

    test('does not call channel.send when channel is not found', async () => {
        member.guild.channels.cache.get = jest.fn().mockReturnValue(undefined);
        await farewellEvent.execute(member, {});
        expect(sendSpy).not.toHaveBeenCalled();
    });

    test('does not call channel.send when bot lacks SendMessages permission', async () => {
        const perms = { has: jest.fn().mockReturnValue(false) };
        const channel = { send: sendSpy, permissionsFor: jest.fn().mockReturnValue(perms) };
        member.guild.channels.cache.get = jest.fn().mockReturnValue(channel);
        await farewellEvent.execute(member, {});
        expect(sendSpy).not.toHaveBeenCalled();
    });

    test('does not throw when guildSettings is null', async () => {
        const Guild = require('../src/models/Guild');
        Guild.findOne.mockResolvedValue(null);
        await expect(farewellEvent.execute(member, {})).resolves.toBeUndefined();
    });
});
