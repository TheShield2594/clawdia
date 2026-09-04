'use strict';

// The guild settings cache was built to take the per-event `Guild.findOne` off
// the hot paths, but only messageCreate and interactionCreate were ever wired
// into it (#594). These tests hold the rest of the read-only handlers to the
// same rule: one read per guild per TTL, not one read per event.

jest.mock('discord.js', () => {
    const EmbedBuilder = jest.fn().mockImplementation(() => {
        const self = {
            data: {},
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockReturnThis(),
            setDescription: jest.fn().mockReturnThis(),
            setThumbnail: jest.fn().mockReturnThis(),
            setAuthor: jest.fn().mockReturnThis(),
            setImage: jest.fn().mockReturnThis(),
            addFields: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
        };
        return self;
    });
    return {
        EmbedBuilder,
        AuditLogEvent: { ChannelCreate: 10, ChannelDelete: 12, MemberKick: 20 },
        PermissionFlagsBits: { SendMessages: 1n << 11n },
    };
});

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/GuildAnalytics', () => ({ updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) }));
jest.mock('../src/services/antiNukeService', () => ({ trackAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/questService', () => ({
    ensureQuests: jest.fn().mockResolvedValue({}),
    onReaction: jest.fn().mockResolvedValue({ completed: [], nearComplete: [] }),
    notifyQuestComplete: jest.fn().mockResolvedValue(undefined),
    notifyQuestNearComplete: jest.fn().mockResolvedValue(undefined),
}));

const Guild = require('../src/models/Guild');
const { clearGuildSettingsCache, setGuildSettingsTtl } = require('../src/utils/guildSettingsCache');

const messageDelete = require('../src/events/messageDelete');
const messageUpdate = require('../src/events/messageUpdate');
const guildMemberUpdate = require('../src/events/guildMemberUpdate');
const channelCreate = require('../src/events/channelCreate');
const channelDelete = require('../src/events/channelDelete');
const messageReactionRemove = require('../src/events/messageReactionRemove');
const messageReactionAdd = require('../src/events/messageReactionAdd');

const GUILD_ID = '999888777666555444';

// Stands in for a hydrated Mongoose document: the cache calls toObject() on it.
function makeDoc(overrides = {}) {
    const plain = {
        guildId: GUILD_ID,
        eventLog: { enabled: false },
        tempVoice: { enabled: false, activeChannels: [] },
        reactionRoles: [],
        starboard: { enabled: false },
        quests: { enabled: false },
        ...overrides,
    };
    return { ...plain, toObject: () => JSON.parse(JSON.stringify(plain)) };
}

function makeGuild() {
    return {
        id: GUILD_ID,
        name: 'Cool Server',
        members: { me: {}, fetch: jest.fn().mockResolvedValue(null) },
        channels: { cache: { get: jest.fn().mockReturnValue(null) } },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    clearGuildSettingsCache();
    setGuildSettingsTtl(30_000);
    Guild.findOne.mockResolvedValue(makeDoc());
    Guild.updateOne.mockResolvedValue({ modifiedCount: 1 });
});

// Each entry fires its handler twice for the same guild. Before #594 that was
// two full document reads; through the cache it is one.
const HANDLERS = [
    ['messageDelete', () => messageDelete.execute({
        author: { bot: false }, guild: makeGuild(), channel: { id: 'c1' },
        content: 'hi', attachments: { size: 0 },
    })],
    ['messageUpdate', () => messageUpdate.execute(
        { content: 'before' },
        { author: { bot: false }, guild: makeGuild(), channel: { id: 'c1' }, content: 'after', url: 'u' },
    )],
    ['guildMemberUpdate', () => {
        const member = { guild: makeGuild(), roles: { cache: new Map() }, user: {} };
        return guildMemberUpdate.execute(member, member);
    }],
    ['channelCreate', () => channelCreate.execute({ id: 'c9', guild: makeGuild(), name: 'n', type: 0 })],
    ['channelDelete', () => channelDelete.execute({ id: 'c9', guild: makeGuild(), name: 'n', type: 0 })],
    ['messageReactionRemove', () => messageReactionRemove.execute(
        { partial: false, emoji: { name: '⭐' }, message: { id: 'm1', guild: makeGuild() } },
        { bot: false, id: 'u1' },
        {},
    )],
];

describe('read-only event handlers read through guildSettingsCache', () => {
    it.each(HANDLERS)('%s issues one document read for two events', async (_name, fire) => {
        await fire();
        await fire();

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });

    it.each(HANDLERS)('%s asks for the projection that leaves the heavy payload behind', async (_name, fire) => {
        await fire();

        expect(Guild.findOne.mock.calls[0][1]).toContain('-giveaways.entrantIds');
    });
});

describe('messageReactionAdd', () => {
    function makeReaction(overrides = {}) {
        return {
            partial: false,
            emoji: { name: '⭐' },
            message: {
                id: 'm1',
                partial: false,
                guild: makeGuild(),
                channel: { id: 'c1' },
                author: { id: 'someone-else', tag: 't', displayAvatarURL: () => 'a' },
                content: 'hello',
                url: 'https://discord/m1',
                createdAt: new Date(),
                attachments: { size: 0 },
                reactions: { cache: { find: () => ({ count: 5 }) } },
            },
            ...overrides,
        };
    }

    it('reads through the cache rather than per reaction', async () => {
        await messageReactionAdd.execute(makeReaction(), { bot: false, id: 'u1' }, { user: { id: 'bot' } });
        await messageReactionAdd.execute(makeReaction(), { bot: false, id: 'u1' }, { user: { id: 'bot' } });

        expect(Guild.findOne).toHaveBeenCalledTimes(1);
    });

    describe('starboard', () => {
        const STARBOARD = {
            starboard: {
                enabled: true, channelId: 'star-ch', emoji: '⭐',
                threshold: 3, starredMessages: [],
            },
        };

        it('claims the message with a targeted update, never by saving shared settings', async () => {
            Guild.findOne.mockResolvedValue(makeDoc(STARBOARD));

            await messageReactionAdd.execute(makeReaction(), { bot: false, id: 'u1' }, { user: { id: 'bot' } });

            expect(Guild.updateOne).toHaveBeenCalledTimes(1);
            const [filter, update] = Guild.updateOne.mock.calls[0];
            expect(filter).toEqual({
                guildId: GUILD_ID,
                'starboard.starredMessages': { $ne: 'm1' },
            });
            expect(update).toEqual({ $push: { 'starboard.starredMessages': 'm1' } });
        });

        it('does not post when another reaction already claimed the message', async () => {
            // The claim matched nothing, so a concurrent handler got there first.
            Guild.updateOne.mockResolvedValue({ modifiedCount: 0 });
            const starChannel = { send: jest.fn().mockResolvedValue(undefined) };
            const guild = makeGuild();
            guild.channels.cache.get = jest.fn().mockReturnValue(starChannel);

            const settings = makeDoc(STARBOARD);
            Guild.findOne.mockResolvedValue(settings);

            const reaction = makeReaction();
            reaction.message.guild = guild;
            await messageReactionAdd.execute(reaction, { bot: false, id: 'u1' }, { user: { id: 'bot' } });

            expect(starChannel.send).not.toHaveBeenCalled();
        });

        it('posts once when the claim succeeds', async () => {
            const starChannel = { send: jest.fn().mockResolvedValue(undefined) };
            const guild = makeGuild();
            guild.channels.cache.get = jest.fn().mockReturnValue(starChannel);

            Guild.findOne.mockResolvedValue(makeDoc(STARBOARD));

            const reaction = makeReaction();
            reaction.message.guild = guild;
            await messageReactionAdd.execute(reaction, { bot: false, id: 'u1' }, { user: { id: 'bot' } });

            expect(starChannel.send).toHaveBeenCalledTimes(1);
        });

        it('leaves the shared settings object untouched', async () => {
            const settings = makeDoc(STARBOARD);
            Guild.findOne.mockResolvedValue(settings);

            await messageReactionAdd.execute(makeReaction(), { bot: false, id: 'u1' }, { user: { id: 'bot' } });

            // A cached entry is shared with every other reader of this guild, so
            // a handler that appended to it would corrupt their view too.
            expect(settings.starboard.starredMessages).toEqual([]);
        });

        it('stays below the threshold without claiming anything', async () => {
            Guild.findOne.mockResolvedValue(makeDoc({
                starboard: { ...STARBOARD.starboard, threshold: 99 },
            }));

            await messageReactionAdd.execute(makeReaction(), { bot: false, id: 'u1' }, { user: { id: 'bot' } });

            expect(Guild.updateOne).not.toHaveBeenCalled();
        });
    });
});
