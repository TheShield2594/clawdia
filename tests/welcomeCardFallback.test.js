'use strict';

// #592, the part that matters on the wire: when the welcome card is refused —
// the guild is past its cards-per-minute budget, the render queue is saturated,
// or the encode failed — the join still gets a welcome. It gets the plain embed
// the handler already had, not a dropped message and not a card rendered anyway.

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
const { createWelcomeCard } = require('../src/utils/cardGenerator');
const { clearGuildSettingsCache } = require('../src/utils/guildSettingsCache');
const { _resetCardRenderQueue, GUILD_LIMIT } = require('../src/utils/cardRenderQueue');
const guildMemberAdd = require('../src/events/guildMemberAdd');

const GUILD_ID = '111222333444555666';
let send;

function makeDoc() {
    const plain = {
        guildId: GUILD_ID,
        welcome: { enabled: true, cardEnabled: true, dmEnabled: false, message: 'welcome {user}', channelId: 'chan-1' },
        autoRoles: [],
        eventLog: { enabled: false },
        moderation: { logChannelId: null },
        antiNuke: { joinGate: { enabled: false } },
        raidDetection: { enabled: false },
    };
    return { ...plain, toObject: () => JSON.parse(JSON.stringify(plain)) };
}

let seq = 0;
function makeMember() {
    const channel = {
        id: 'chan-1',
        send,
        // Both SendMessages and AttachFiles, so nothing but the budget decides.
        permissionsFor: () => ({ has: () => true }),
    };
    return {
        id: `user_${++seq}`,
        user: {
            bot: false, username: 'newcomer', displayName: 'Newcomer',
            createdTimestamp: Date.now() - 86400000 * 365,
            displayAvatarURL: () => 'https://cdn.example/a.png',
        },
        send: jest.fn().mockResolvedValue(undefined),
        roles: { add: jest.fn(), cache: new Map() },
        guild: {
            id: GUILD_ID,
            name: 'Cool Server',
            memberCount: 42,
            members: { me: {} },
            channels: { cache: { get: id => (id === 'chan-1' ? channel : null) } },
            roles: { cache: { get: () => null } },
        },
    };
}

const sentWithCard = () => send.mock.calls.filter(([payload]) => payload.files?.length).length;

beforeEach(() => {
    jest.clearAllMocks();
    clearGuildSettingsCache();
    _resetCardRenderQueue();
    send = jest.fn().mockResolvedValue(undefined);
    Guild.findOne.mockResolvedValue(makeDoc());
    createWelcomeCard.mockResolvedValue(Buffer.from('card'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('welcome card under load', () => {
    test('an ordinary join still gets the card', async () => {
        await guildMemberAdd.execute(makeMember(), {});

        expect(createWelcomeCard).toHaveBeenCalledTimes(1);
        expect(sentWithCard()).toBe(1);
    });

    // The raid shape: joins keep arriving, the welcome keeps being sent, and the
    // canvas work stops.
    test('stops rendering past the per-guild budget and sends the plain embed', async () => {
        const joins = GUILD_LIMIT + 10;
        for (let i = 0; i < joins; i++) await guildMemberAdd.execute(makeMember(), {});

        expect(createWelcomeCard).toHaveBeenCalledTimes(GUILD_LIMIT);
        expect(send).toHaveBeenCalledTimes(joins);
        expect(sentWithCard()).toBe(GUILD_LIMIT);
    });

    test('a failed render degrades to the plain embed rather than dropping the join', async () => {
        createWelcomeCard.mockRejectedValue(new Error('encode failed'));

        await guildMemberAdd.execute(makeMember(), {});

        expect(send).toHaveBeenCalledTimes(1);
        expect(sentWithCard()).toBe(0);
    });

    test('a guild that never enabled the card renders nothing and spends no budget', async () => {
        const doc = makeDoc();
        doc.welcome.cardEnabled = false;
        doc.toObject = () => JSON.parse(JSON.stringify({ ...doc, toObject: undefined }));
        Guild.findOne.mockResolvedValue(doc);

        await guildMemberAdd.execute(makeMember(), {});

        expect(createWelcomeCard).not.toHaveBeenCalled();
        expect(sentWithCard()).toBe(0);
        expect(send).toHaveBeenCalledTimes(1);
    });
});
