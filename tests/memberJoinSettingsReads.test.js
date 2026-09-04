'use strict';

// #593. A single member join used to cost three independent full guild reads:
// antiNukeService.enforceJoinGate did its own `Guild.findOne`, raidService's
// handleMemberJoin did another, and the handler itself did a third — each one
// hydrating the whole document, shop image Buffers and all. guildMemberAdd now
// resolves the settings once, through the cache, and hands the same object down.

jest.mock('discord.js', () => {
    const EmbedBuilder = jest.fn().mockImplementation(() => ({
        setColor: jest.fn().mockReturnThis(),
        setTitle: jest.fn().mockReturnThis(),
        setDescription: jest.fn().mockReturnThis(),
        setThumbnail: jest.fn().mockReturnThis(),
        setAuthor: jest.fn().mockReturnThis(),
        setImage: jest.fn().mockReturnThis(),
        addFields: jest.fn().mockReturnThis(),
        setTimestamp: jest.fn().mockReturnThis(),
    }));
    return {
        EmbedBuilder,
        AttachmentBuilder: jest.fn(),
        AuditLogEvent: { MemberKick: 20 },
        PermissionFlagsBits: { SendMessages: 1n << 11n, AttachFiles: 1n << 15n },
        PermissionsBitField: { Flags: {} },
        ChannelType: { GuildText: 0 },
    };
});

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/GuildAnalytics', () => ({ updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) }));
jest.mock('../src/utils/cardGenerator', () => ({ createWelcomeCard: jest.fn() }));

const Guild = require('../src/models/Guild');
const { clearGuildSettingsCache, setGuildSettingsTtl } = require('../src/utils/guildSettingsCache');
const guildMemberAdd = require('../src/events/guildMemberAdd');
const { enforceJoinGate } = require('../src/services/antiNukeService');
const { handleMemberJoin } = require('../src/services/raidService');

const GUILD_ID = '111222333444555666';

function makeDoc(overrides = {}) {
    const plain = {
        guildId: GUILD_ID,
        welcome: { enabled: false, dmEnabled: false },
        autoRoles: [],
        eventLog: { enabled: false },
        moderation: { logChannelId: null },
        antiNuke: { joinGate: { enabled: false } },
        raidDetection: { enabled: false },
        ...overrides,
    };
    // Stands in for a hydrated Mongoose document: the cache calls toObject().
    return { ...plain, toObject: () => JSON.parse(JSON.stringify(plain)) };
}

let seq = 0;
function makeMember() {
    return {
        // A fresh user id per join so the raid window counts them separately.
        id: `user_${++seq}`,
        user: { bot: false, username: 'newcomer', displayName: 'Newcomer', createdTimestamp: Date.now() - 86400000 * 365, displayAvatarURL: () => 'a' },
        bannable: true,
        kickable: true,
        kick: jest.fn().mockResolvedValue(undefined),
        ban: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        roles: { add: jest.fn().mockResolvedValue(undefined), cache: new Map() },
        guild: {
            id: GUILD_ID,
            name: 'Cool Server',
            memberCount: 42,
            members: { me: {} },
            channels: { cache: { get: jest.fn().mockReturnValue(null) } },
            roles: { cache: { get: jest.fn().mockReturnValue(null) } },
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    clearGuildSettingsCache();
    setGuildSettingsTtl(30_000);
    Guild.findOne.mockResolvedValue(makeDoc());
    Guild.updateOne.mockResolvedValue({ modifiedCount: 1 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('guildMemberAdd settings reads', () => {
    it('reads the guild document once for a join, not three times', async () => {
        Guild.findOne.mockResolvedValue(makeDoc({
            // Both services enabled, so both actually consume the settings
            // rather than passing the count by doing nothing.
            antiNuke: { joinGate: { enabled: true, minAccountAgeDays: 0, action: 'kick' } },
            raidDetection: { enabled: true, threshold: 10, windowSeconds: 60, action: 'alert' },
        }));

        await guildMemberAdd.execute(makeMember(), {});

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });

    it('reads through the cache, so a second join in the TTL costs nothing', async () => {
        await guildMemberAdd.execute(makeMember(), {});
        await guildMemberAdd.execute(makeMember(), {});

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });

    it('leaves the giveaway entrant lists in the database', async () => {
        await guildMemberAdd.execute(makeMember(), {});

        expect(Guild.findOne.mock.calls[0][1]).toContain('-giveaways.entrantIds');
    });

    it('still enforces the join gate off the settings it was handed', async () => {
        Guild.findOne.mockResolvedValue(makeDoc({
            antiNuke: { joinGate: { enabled: true, minAccountAgeDays: 30, action: 'kick' } },
        }));
        const member = makeMember();
        member.user.createdTimestamp = Date.now() - 86400000; // one day old

        await guildMemberAdd.execute(member, {});

        expect(member.kick).toHaveBeenCalledTimes(1);
        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });

    it('skips the rest of the handler once the gate removes the member', async () => {
        Guild.findOne.mockResolvedValue(makeDoc({
            antiNuke: { joinGate: { enabled: true, minAccountAgeDays: 30, action: 'kick' } },
            welcome: { enabled: true, dmEnabled: true, dmMessage: 'hi {user}', message: 'hi' },
        }));
        const member = makeMember();
        member.user.createdTimestamp = Date.now() - 86400000;

        await guildMemberAdd.execute(member, {});

        expect(member.send).not.toHaveBeenCalled();
    });

    it('still runs when the guild has no document at all', async () => {
        Guild.findOne.mockResolvedValue(null);
        const member = makeMember();

        await expect(guildMemberAdd.execute(member, {})).resolves.toBeUndefined();

        expect(member.kick).not.toHaveBeenCalled();
        expect(member.send).not.toHaveBeenCalled();
    });
});

describe('the services still read for themselves when called alone', () => {
    // Neither one is guildMemberAdd's private helper — a caller with nothing to
    // hand down has to keep working.
    it('enforceJoinGate falls back to its own read', async () => {
        Guild.findOne.mockResolvedValue(makeDoc({
            antiNuke: { joinGate: { enabled: true, minAccountAgeDays: 30, action: 'kick' } },
        }));
        const member = makeMember();
        member.user.createdTimestamp = Date.now() - 86400000;

        await expect(enforceJoinGate(member)).resolves.toBe(true);

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
        expect(member.kick).toHaveBeenCalledTimes(1);
    });

    it('handleMemberJoin falls back to its own read', async () => {
        Guild.findOne.mockResolvedValue(makeDoc({
            raidDetection: { enabled: true, threshold: 10, windowSeconds: 60, action: 'alert' },
        }));

        await handleMemberJoin(makeMember(), {});

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });

    it('handleMemberJoin takes null for a guild that has no settings', async () => {
        await expect(handleMemberJoin(makeMember(), {}, null)).resolves.toBeUndefined();

        expect(Guild.findOne).not.toHaveBeenCalled();
    });
});
