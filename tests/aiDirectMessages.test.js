'use strict';

// Talking to the AI by DM: answered as a message in the operator's home server
// (AI_DM_GUILD_ID), and only for that server's admins.

jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));
jest.mock('../src/services/aiService', () => ({ handleAIChat: jest.fn(async () => {}) }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn(), countDocuments: jest.fn(async () => 0) }));

const { PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { handleAIChat } = require('../src/services/aiService');
const { resolveDmContext, asHomeMessage, homeGuildId } = require('../src/services/ai/directMessages');
const messageCreate = require('../src/events/messageCreate');

const HOME = '111111111111111111';
const ORIGINAL = process.env.AI_DM_GUILD_ID;

function makeMember({ admin = true } = {}) {
    return { id: 'u1', permissions: { has: perm => admin && perm === PermissionFlagsBits.ManageGuild } };
}

function makeClient({ member = makeMember(), inCache = true } = {}) {
    const guild = {
        id: HOME,
        members: { fetch: jest.fn(async () => { if (!member) throw new Error('Unknown Member'); return member; }) }
    };
    return { guild, client: { user: { id: 'bot' }, guilds: { cache: { get: id => (inCache && id === HOME ? guild : undefined) } } } };
}

function makeDm(content = 'what is on my calendar today?') {
    const message = {
        author: { id: 'u1', bot: false },
        guild: null,
        content,
        channel: { id: 'dm1', isDMBased: () => true, send: jest.fn() },
        reply: jest.fn(function reply() { return this; })
    };
    return message;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_DM_GUILD_ID = HOME;
    getGuildSettings.mockResolvedValue({ ai: { enabled: true, provider: 'openai' } });
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.AI_DM_GUILD_ID;
    else process.env.AI_DM_GUILD_ID = ORIGINAL;
});

describe('which DMs are answered', () => {
    test('none unless the operator named a home server', async () => {
        delete process.env.AI_DM_GUILD_ID;
        expect(homeGuildId()).toBeNull();
        await expect(resolveDmContext(makeDm(), makeClient().client)).resolves.toBeNull();
    });

    test('a value that is not a server id is no home server', () => {
        process.env.AI_DM_GUILD_ID = 'my server';
        expect(homeGuildId()).toBeNull();
    });

    test('an admin of the home server is answered with its settings', async () => {
        const { client, guild } = makeClient();
        const context = await resolveDmContext(makeDm(), client);
        expect(context.guild).toBe(guild);
        expect(context.settings.ai.enabled).toBe(true);
        // Forced past the cache, since this decides who may use the bot.
        expect(guild.members.fetch).toHaveBeenCalledWith({ user: 'u1', force: true });
    });

    test('a member without Manage Server is not', async () => {
        await expect(resolveDmContext(makeDm(), makeClient({ member: makeMember({ admin: false }) }).client)).resolves.toBeNull();
    });

    test('nor is somebody who is not in the server at all', async () => {
        await expect(resolveDmContext(makeDm(), makeClient({ member: null }).client)).resolves.toBeNull();
    });

    test('nor anyone, while the home server has the AI off', async () => {
        getGuildSettings.mockResolvedValue({ ai: { enabled: false } });
        await expect(resolveDmContext(makeDm(), makeClient().client)).resolves.toBeNull();
    });

    test('a home server this process cannot see is ignored, with a warning', async () => {
        await expect(resolveDmContext(makeDm(), makeClient({ inCache: false }).client)).resolves.toBeNull();
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/not a server this process can see/));
    });
});

describe('the DM as the chat transport sees it', () => {
    test('reads the home server and member, and talks back to the DM', () => {
        const dm = makeDm();
        const { guild } = makeClient();
        const member = makeMember();
        const home = asHomeMessage(dm, guild, member);

        expect(home.guild).toBe(guild);
        expect(home.member).toBe(member);
        expect(home.channel).toBe(dm.channel);
        expect(home.author).toBe(dm.author);
        // A method runs on the real message, so the reply is made in the DM.
        expect(home.reply('hi')).toBe(dm);
    });
});

describe('messageCreate', () => {
    test('hands an admin\'s DM to the AI, as a message in the home server', async () => {
        const { client, guild } = makeClient();
        await messageCreate.execute(makeDm('plan my week'), client);

        expect(handleAIChat).toHaveBeenCalledTimes(1);
        const [message, ai, content] = handleAIChat.mock.calls[0];
        expect(message.guild).toBe(guild);
        expect(ai.enabled).toBe(true);
        expect(content).toBe('plan my week');
    });

    test('says nothing to anyone else', async () => {
        const dm = makeDm();
        await messageCreate.execute(dm, makeClient({ member: makeMember({ admin: false }) }).client);
        expect(handleAIChat).not.toHaveBeenCalled();
        expect(dm.reply).not.toHaveBeenCalled();
    });

    test('ignores bots, in DMs as everywhere', async () => {
        const dm = makeDm();
        dm.author.bot = true;
        await messageCreate.execute(dm, makeClient().client);
        expect(handleAIChat).not.toHaveBeenCalled();
    });
});
