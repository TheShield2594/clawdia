'use strict';

// #820: what the user actually said, once the bot's own mention token is out of it.
//
// A mention-triggered message arrives as `<@botid> !reset`. The event handler
// stripped that token for the natural-language reminder check and then threw
// the result away, so the chat transport went on reading `message.content`:
// `!reset` never matched behind a mention — it only ever worked as a bare reply
// to the bot — and the raw `<@123…>` token was pasted into every prompt, every
// knowledge lookup and every history entry.
//
// The stripped content is now computed once and handed down, which is one fix
// for both. These cover the two halves: the handler passing it, and the
// transport using it in place of `message.content`.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null })),
    create: jest.fn(),
}));
jest.mock('../src/models/Guild', () => ({ create: jest.fn() }));
jest.mock('../src/models/Case', () => ({ findOne: jest.fn().mockResolvedValue(null), countDocuments: jest.fn().mockResolvedValue(0) }));
jest.mock('../src/models/Reminder', () => ({ create: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () => ({ getGuildSettings: jest.fn() }));

// The event handler reaches the transport through the facade, so that is what
// the wiring half watches. The transport half requires the module itself, which
// this mock does not stand in front of.
jest.mock('../src/services/aiService', () => ({ handleAIChat: jest.fn() }));

jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async () => ({ entries: [], isBackground: false })),
    buildKnowledgeContext: jest.fn(() => ''),
}));
jest.mock('../src/services/ai/history', () => ({
    loadHistory: jest.fn(async () => ({ messages: [] })),
    appendHistory: jest.fn(async () => {}),
    clearHistory: jest.fn(async () => {}),
}));
jest.mock('../src/services/ai/mcp/resources', () => ({ retrieveMcpKnowledge: jest.fn(async () => null) }));
jest.mock('../src/services/ai/mcp/usage', () => ({ recordToolCalls: jest.fn(async () => {}) }));
jest.mock('../src/services/ai/providers', () => ({
    providers: new Map([['mock', { name: 'mock', label: 'Mock' }]]),
    mcpMode: () => null,
    usesClientTools: () => false,
    // Text-only, so the transport never reaches for an attachment here.
    supportsVision: () => false,
}));

const mockStream = jest.fn();
const mockComplete = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: () => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        apiKey: 'k', baseUrl: null, mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 },
    }),
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: (...args) => mockComplete(...args),
    DEFAULT_MODELS: { mock: 'mock-1' },
}));

const { handleAIChat: facadeChat } = require('../src/services/aiService');
const { getGuildSettings } = require('../src/utils/guildSettingsCache');
const { retrieveKnowledge } = require('../src/services/ai/knowledge');
const { appendHistory, clearHistory } = require('../src/services/ai/history');
const messageCreate = require('../src/events/messageCreate');
const { handleAIChat } = require('../src/services/ai/discordChat');

const BOT_ID = 'bot1';

beforeEach(() => {
    jest.clearAllMocks();
    mockStream.mockImplementation(async function* () { yield 'an answer'; });
    mockComplete.mockResolvedValue('an answer');
});

describe('the event handler', () => {
    function mentionMessage(content) {
        return {
            id: 'msg1',
            content,
            author: { id: 'author1', bot: false, toString: () => '<@author1>' },
            attachments: new Map(),
            mentions: { has: () => true },
            member: { id: 'author1', permissions: { has: () => false }, roles: { cache: { some: () => false } } },
            guild: { id: 'guild1', name: 'Guild One' },
            channel: { id: 'chan1', send: jest.fn(), sendTyping: jest.fn() },
            client: { user: { id: BOT_ID } },
        };
    }

    const run = message => messageCreate.execute(message, { user: { id: BOT_ID } });

    // The third argument is the stripped content the transport now reads.
    const promptGiven = () => facadeChat.mock.calls.at(-1)?.[2];

    beforeEach(() => {
        getGuildSettings.mockResolvedValue({
            ai: { enabled: true, channelPersonas: [] },
            leveling: { enabled: false },
            moderation: { enabled: false },
            suggestions: { enabled: false },
            bibleVerse: { autoRespond: false },
        });
    });

    test('hands the chat transport the content without the mention token', async () => {
        await run(mentionMessage(`<@${BOT_ID}> what is the capital of France?`));

        expect(facadeChat).toHaveBeenCalledTimes(1);
        expect(promptGiven()).toBe('what is the capital of France?');
        expect(promptGiven()).not.toContain(BOT_ID);
    });

    // Discord sends either form of the token depending on the client.
    test('and the nickname form of the token', async () => {
        await run(mentionMessage(`<@!${BOT_ID}> hello`));

        expect(promptGiven()).toBe('hello');
    });

    test('a mention-triggered !reset reaches the transport as !reset', async () => {
        await run(mentionMessage(`<@${BOT_ID}> !reset`));

        expect(promptGiven()).toBe('!reset');
    });
});

describe('the chat transport', () => {
    const SETTINGS = { provider: 'mock', streaming: false, actionsEnabled: false, maxHistory: 20 };

    function fakeMessage(content) {
        return {
            content,
            author: { id: 'u1' },
            guild: { id: 'g1' },
            channel: { id: 'c1', send: jest.fn(async () => ({})), sendTyping: jest.fn(async () => {}) },
            reply: jest.fn(async payload => ({ payload, edit: jest.fn(), delete: jest.fn() })),
        };
    }

    const replyText = message => {
        const payload = message.reply.mock.calls.at(-1)?.[0];
        return typeof payload === 'string' ? payload : payload?.content ?? '';
    };

    test('!reset behind a mention clears the history', async () => {
        const message = fakeMessage(`<@${BOT_ID}> !reset`);

        await handleAIChat(message, SETTINGS, '!reset');

        expect(clearHistory).toHaveBeenCalledWith('g1', 'c1', 'u1');
        expect(mockComplete).not.toHaveBeenCalled();
        expect(replyText(message)).toMatch(/history cleared/i);
    });

    test('the mention token reaches neither the prompt, the knowledge lookup nor the history', async () => {
        const message = fakeMessage(`<@${BOT_ID}> who are you?`);

        await handleAIChat(message, SETTINGS, 'who are you?');

        expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'who are you?' }));
        expect(retrieveKnowledge).toHaveBeenCalledWith('g1', 'who are you?');
        expect(appendHistory).toHaveBeenCalledWith(
            'g1', 'c1', 'u1', 'who are you?', expect.any(String), 20, expect.anything(),
        );
    });

    // Nothing was passed down, so the raw content is what it reads — which is
    // what the reply-to-bot trigger wants, since that content has no token in it.
    test('falls back to the raw content when nothing was stripped for it', async () => {
        const message = fakeMessage('who are you?');

        await handleAIChat(message, SETTINGS);

        expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'who are you?' }));
    });

    // A bare `@Clawdia` is all mention and no question. It used to reach the
    // provider as the literal token; stripped, it would reach it as an empty
    // prompt, which some providers reject outright.
    test('a mention with nothing after it asks rather than sending an empty prompt', async () => {
        const message = fakeMessage(`<@${BOT_ID}>`);

        await handleAIChat(message, SETTINGS, '');

        expect(mockComplete).not.toHaveBeenCalled();
        expect(replyText(message)).toMatch(/did not ask anything/i);
    });
});
