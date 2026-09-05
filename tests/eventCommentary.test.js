'use strict';

/**
 * #836. Colour commentary on the resolutions the scheduler already posts.
 *
 * Two things are worth pinning here, and they pull in opposite directions.
 *
 * It has to be *off* unless a guild asked for it — this is the only AI call in
 * the bot that nobody typed, so a server that connected a key for chat must not
 * find its war announcements quietly spending money.
 *
 * And when it fails it has to fail into the announcement that already existed.
 * These run inside jobs that have paid people out; a provider outage may cost a
 * guild its commentary and may not cost it its war result.
 */

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setImage(i) { this.image = i; return this; }
        setFooter() { return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.fields.push(...f.flat()); return this; }
    }
    class AttachmentBuilder {
        constructor(buf, opts) { this.buf = buf; this.name = opts?.name; }
    }
    return { EmbedBuilder, AttachmentBuilder };
});

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ find: jest.fn(), findOne: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/utils/cardGenerator', () => ({
    createWarVictoryBanner: jest.fn(async () => Buffer.from('banner')),
    createSeasonRecapCard:  jest.fn(async () => Buffer.from('recap')),
    generatePetSprite:      jest.fn(async () => Buffer.from('sprite')),
}));

const mockGetCompletion = jest.fn();
jest.mock('../src/services/aiService', () => ({
    resolveProviderConfig: settings => ({
        provider: settings.provider || 'openai',
        model: 'mock-1',
        apiKey: settings.openaiKey ?? null,
        baseUrl: null,
        mcpServers: [],
        rateLimit: {},
    }),
    getCompletion: (...args) => mockGetCompletion(...args),
}));

const Guild = require('../src/models/Guild');
const User  = require('../src/models/User');
const { eventCommentary, addCommentary, commentaryEnabled, MAX_CHARS } = require('../src/services/commentaryService');
const { resolveExpiredWars } = require('../src/services/warService');

const HOUR = 3600_000;

/** A guild with commentary switched on and a key to pay for it. */
function guildDoc(over = {}) {
    return {
        guildId: 'g1',
        name: 'Home',
        ai: { enabled: true, provider: 'openai', openaiKey: 'sk-test', eventCommentary: true, systemPrompt: 'You are a sardonic pirate.' },
        ...over,
    };
}

let warnLog;
let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    mockGetCompletion.mockResolvedValue('What a finish.');
    warnLog = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { warnLog.mockRestore(); errorLog.mockRestore(); });

describe('when a guild gets commentary at all', () => {
    const ask = doc => eventCommentary(doc, { event: 'war', facts: { outcome: 'Home won' } });

    test('not unless it turned the setting on', async () => {
        const doc = guildDoc({ ai: { ...guildDoc().ai, eventCommentary: false } });

        expect(commentaryEnabled(doc)).toBe(false);
        await expect(ask(doc)).resolves.toBeNull();
        expect(mockGetCompletion).not.toHaveBeenCalled();
    });

    test('not when AI itself is off, whatever the toggle says', async () => {
        const doc = guildDoc({ ai: { ...guildDoc().ai, enabled: false } });

        expect(commentaryEnabled(doc)).toBe(false);
        await expect(ask(doc)).resolves.toBeNull();
        expect(mockGetCompletion).not.toHaveBeenCalled();
    });

    // A guild can have the toggle on and no way to pay: the key was removed and
    // the setting stayed. Nothing to do but skip it.
    test('not without a usable provider', async () => {
        const doc = guildDoc({ ai: { ...guildDoc().ai, openaiKey: null } });

        expect(commentaryEnabled(doc)).toBe(false);
        await expect(ask(doc)).resolves.toBeNull();
    });

    // Ollama is the exception the rest of the codebase makes: no key, but a
    // base URL and no bill.
    test('but a self-hosted Ollama needs no key', () => {
        expect(commentaryEnabled(guildDoc({ ai: { ...guildDoc().ai, provider: 'ollama', openaiKey: null } }))).toBe(true);
    });

    test('and never for an event nobody defined', async () => {
        await expect(eventCommentary(guildDoc(), { event: 'nonsense', facts: {} })).resolves.toBeNull();
        expect(mockGetCompletion).not.toHaveBeenCalled();
    });
});

describe('the call it makes', () => {
    async function callFor(over) {
        await eventCommentary(guildDoc(over), { event: 'season', facts: { season: 'Autumn', 'final podium': '1. Ann' } });
        return mockGetCompletion.mock.calls.at(-1)?.[0];
    }

    test('speaks in the server\'s own configured voice', async () => {
        const req = await callFor();
        expect(req.systemPrompt).toMatch(/sardonic pirate/);
    });

    test('is billed to the guild, and to nobody in particular', async () => {
        const req = await callFor();

        // The ledger and the monthly ceilings need this; the per-user and
        // per-channel windows have no user to bind to, because nobody asked.
        expect(req.guildId).toBe('g1');
        expect(req.userId).toBeUndefined();
        expect(req.channelId).toBeUndefined();
    });

    test('offers the model no tools — a commentator has nothing to look up', async () => {
        expect((await callFor()).mcp).toBe(false);
    });

    test('carries the facts and asks for nothing else', async () => {
        const req = await callFor();

        expect(req.prompt).toMatch(/season: Autumn/);
        expect(req.prompt).toMatch(/final podium: 1\. Ann/);
        expect(req.systemPrompt).toMatch(/never invent a number/);
    });

    test('keeps it short enough to sit in an embed field', async () => {
        const req = await callFor();
        expect(req.maxTokens).toBeLessThanOrEqual(256);
    });

    test('drops a fact it was given nothing for', async () => {
        await eventCommentary(guildDoc(), { event: 'war', facts: { outcome: 'Home won', MVP: null, margin: '' } });
        const { prompt } = mockGetCompletion.mock.calls.at(-1)[0];

        expect(prompt).toMatch(/outcome: Home won/);
        expect(prompt).not.toMatch(/MVP/);
        expect(prompt).not.toMatch(/margin/);
    });
});

describe('what comes back', () => {
    const ask = () => eventCommentary(guildDoc(), { event: 'war', facts: { outcome: 'Home won' } });

    test('is handed over as written when it is fine', async () => {
        mockGetCompletion.mockResolvedValue('  A rout, start to finish.  ');
        await expect(ask()).resolves.toBe('A rout, start to finish.');
    });

    // An embed cannot ping anybody, so this is about a bot that appears to be
    // trying rather than one that succeeds.
    test('loses its mass mentions', async () => {
        mockGetCompletion.mockResolvedValue('@everyone go congratulate <@&99> them!');
        await expect(ask()).resolves.toBe('go congratulate  them!');
    });

    test('is trimmed to something an embed field will take', async () => {
        mockGetCompletion.mockResolvedValue('x'.repeat(5000));
        const text = await ask();

        expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
        expect(text.endsWith('…')).toBe(true);
    });

    test('is null when the model says nothing', async () => {
        mockGetCompletion.mockResolvedValue('   ');
        await expect(ask()).resolves.toBeNull();
    });

    test('is null when the provider is down, and nothing throws', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));
        await expect(ask()).resolves.toBeNull();
    });

    // The guild's own monthly ceiling refusing is not a reason to lose the
    // announcement either — unlike the /newspaper preview, nobody is waiting on
    // an answer here to know their request was refused.
    test('is null when the guild\'s own budget refuses', async () => {
        mockGetCompletion.mockRejectedValue(Object.assign(new Error('limit'), { rateLimited: true }));
        await expect(ask()).resolves.toBeNull();
    });
});

describe('putting it on an embed', () => {
    const { EmbedBuilder } = require('discord.js');

    test('adds a field when there is commentary', () => {
        const embed = addCommentary(new EmbedBuilder(), 'A rout.');
        expect(embed.fields).toEqual([{ name: '🎙️ Commentary', value: 'A rout.' }]);
    });

    // This is what makes the static embed the fallback rather than a second
    // code path: the announcement is already built, and a null answer leaves it
    // exactly as it was.
    test('leaves the announcement untouched when there is none', () => {
        const embed = addCommentary(new EmbedBuilder(), null);
        expect(embed.fields).toEqual([]);
    });
});

describe('a war resolution carrying it', () => {
    function fakeClient() {
        const sent = [];
        return {
            sent,
            client: {
                guilds: {
                    fetch: jest.fn(async guildId => ({
                        id: guildId,
                        channels: {
                            fetch: async channelId => ({
                                isTextBased: () => true,
                                send: async payload => { sent.push({ guildId, channelId, payload }); },
                            }),
                        },
                        members: { fetch: async userId => ({ user: { username: `name-${userId}` } }) },
                    })),
                },
            },
        };
    }

    function chain(docs) {
        const c = { sort: () => c, limit: () => c, select: () => c, lean: async () => docs };
        return c;
    }

    function warGuild(over = {}) {
        return {
            ...guildDoc(),
            activeWar: {
                status: 'active',
                myScore: 100,
                opponentScore: 40,
                opponentGuildId: 'g2',
                opponentGuildName: 'Away',
                announcementChannelId: 'c1',
                endsAt: new Date(Date.now() - HOUR),
            },
            ...over,
        };
    }

    // The opposing guild, which pays for its own commentary or does not get any.
    function opponent(ai) {
        return {
            guildId: 'g2',
            name: 'Away',
            ai,
            activeWar: { announcementChannelId: 'c2' },
        };
    }

    beforeEach(() => {
        Guild.findOneAndUpdate.mockResolvedValue({ guildId: 'g1' });
        User.findOne.mockReturnValue(chain(null));
        User.updateMany.mockResolvedValue({});
    });

    function commentaryOn(sent, guildId) {
        const post = sent.find(s => s.guildId === guildId);
        return post?.payload?.embeds?.[0]?.fields?.find(f => f.name === '🎙️ Commentary')?.value ?? null;
    }

    test('puts the model\'s line under the winner\'s announcement', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        Guild.findOne.mockReturnValue({ lean: async () => opponent({ enabled: false }) });
        const { client, sent } = fakeClient();

        await resolveExpiredWars(client);

        expect(commentaryOn(sent, 'g1')).toBe('What a finish.');
        expect(mockGetCompletion.mock.calls.at(-1)[0].prompt).toMatch(/Home beat Away/);
    });

    // Each server pays for its own voice. The opponent here has AI off, so it
    // gets the plain embed and is never charged for one.
    test('and asks each server separately, so one can decline', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        Guild.findOne.mockReturnValue({ lean: async () => opponent({ enabled: false }) });
        const { client, sent } = fakeClient();

        await resolveExpiredWars(client);

        expect(commentaryOn(sent, 'g2')).toBeNull();
        expect(mockGetCompletion).toHaveBeenCalledTimes(1);
    });

    test('when both want it, each is charged once and told which side it is writing for', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        Guild.findOne.mockReturnValue({ lean: async () => opponent(guildDoc().ai) });
        const { client, sent } = fakeClient();

        await resolveExpiredWars(client);

        expect(mockGetCompletion).toHaveBeenCalledTimes(2);
        expect(commentaryOn(sent, 'g1')).toBe('What a finish.');
        expect(commentaryOn(sent, 'g2')).toBe('What a finish.');

        const prompts = mockGetCompletion.mock.calls.map(c => c[0].prompt);
        expect(prompts.some(p => /how it went for them: they won/.test(p))).toBe(true);
        expect(prompts.some(p => /how it went for them: they lost/.test(p))).toBe(true);
    });

    // The payout has already landed by the time this runs. A provider outage
    // costs the commentary and nothing else.
    test('still announces the war when the model fails', async () => {
        mockGetCompletion.mockRejectedValue(new Error('provider down'));
        Guild.find.mockResolvedValue([warGuild()]);
        Guild.findOne.mockReturnValue({ lean: async () => opponent({ enabled: false }) });
        const { client, sent } = fakeClient();

        await resolveExpiredWars(client);

        expect(sent.some(s => s.guildId === 'g1')).toBe(true);
        expect(commentaryOn(sent, 'g1')).toBeNull();
    });

    test('and the winner still gets their banner', async () => {
        Guild.find.mockResolvedValue([warGuild()]);
        Guild.findOne.mockReturnValue({ lean: async () => opponent({ enabled: false }) });
        const { client, sent } = fakeClient();

        await resolveExpiredWars(client);

        const winnerPost = sent.find(s => s.guildId === 'g1');
        expect(winnerPost.payload.files).toHaveLength(1);
        // And the loser is not sent the winner's banner.
        expect(sent.find(s => s.guildId === 'g2').payload.files).toBeUndefined();
    });
});
