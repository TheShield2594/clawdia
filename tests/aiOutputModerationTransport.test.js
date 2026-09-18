'use strict';

// #1043: a guild that screens the bot's own replies runs the reply through the
// non-streaming path (so nothing reaches Discord before the verdict), and a
// flagged reply is replaced with a short withheld notice — no model text, no
// tool footer, and nothing written to history. A null/allow verdict is
// fail-open: the reply posts exactly as it would without the feature.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null }))
}));

jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async () => ({ entries: [], isBackground: false })),
    knowledgeSection: jest.fn(() => ({ header: '', joiner: '', items: [] }))
}));

const mockAppendHistory = jest.fn(async () => {});
jest.mock('../src/services/ai/history', () => ({
    loadHistory: jest.fn(async () => ({ messages: [] })),
    appendHistory: (...args) => mockAppendHistory(...args),
    clearHistory: jest.fn(async () => {})
}));

jest.mock('../src/services/ai/mcp/resources', () => ({
    retrieveMcpKnowledge: jest.fn(async () => null)
}));

jest.mock('../src/services/ai/mcp/usage', () => ({
    recordToolCalls: jest.fn(async () => {})
}));

jest.mock('../src/services/ai/providers', () => ({
    providers: new Map([['mock', { name: 'mock', label: 'Mock' }]]),
    mcpMode: () => 'client',
    usesClientTools: () => true,
    supportsVision: () => false
}));

const mockStream = jest.fn();
const mockComplete = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: () => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        apiKey: 'k', baseUrl: null, mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 }
    }),
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: (...args) => mockComplete(...args),
    DEFAULT_MODELS: { mock: 'mock-1' }
}));

const WITHHELD = '⚠️ withheld for test';
const mockModerateOutput = jest.fn();
const mockOutputModerationEnabled = jest.fn();
jest.mock('../src/services/aiOutputModerationService', () => ({
    moderateOutput: (...args) => mockModerateOutput(...args),
    outputModerationEnabled: (...args) => mockOutputModerationEnabled(...args),
    WITHHELD_MESSAGE: WITHHELD,
}));

const { handleAIChat } = require('../src/services/ai/discordChat');

// A guild that has streaming on but also screens its output — the two conflict,
// and moderation wins by forcing the buffered (non-streaming) path.
const SETTINGS = { provider: 'mock', streaming: true, actionsEnabled: false, maxHistory: 20 };
const GUILD = { guildId: 'g1', ai: { enabled: true }, moderation: { aiOutputModeration: true } };

function fakeMessage(content = 'hello') {
    const sent = [];
    const emit = payload => {
        const msg = {
            payload,
            content: typeof payload === 'string' ? payload : payload?.content ?? '',
            edit: jest.fn(async next => { msg.edited = next; msg.content = next?.content ?? next; return msg; }),
            delete: jest.fn(async () => msg)
        };
        sent.push(msg);
        return msg;
    };

    const message = {
        content,
        author: { id: 'u1' },
        guild: { id: 'g1' },
        channel: {
            id: 'c1',
            send: jest.fn(async payload => emit(payload)),
            sendTyping: jest.fn(async () => {})
        },
        reply: jest.fn(async payload => emit(payload))
    };
    return { message, sent };
}

function everyPayload(message, sent) {
    const posts = [
        ...message.reply.mock.calls,
        ...message.channel.send.mock.calls
    ].map(call => call[0]);
    const edits = sent.flatMap(msg => msg.edit.mock.calls).map(call => call[0]);
    return [...posts, ...edits].map(p => (typeof p === 'string' ? p : p?.content ?? ''));
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStream.mockImplementation(async function* () { yield 'a normal answer'; });
    mockComplete.mockResolvedValue('a normal answer');
    mockModerateOutput.mockResolvedValue(null); // fail-open default
    mockOutputModerationEnabled.mockReturnValue(true); // guild screens its output
});

describe('moderation forces the buffered (non-streaming) path', () => {
    test('the reply is generated whole, not streamed, even with streaming on', async () => {
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        expect(mockComplete).toHaveBeenCalled();
        expect(mockStream).not.toHaveBeenCalled();
    });

    test('the moderation check is given the full generated reply and the guild', async () => {
        mockComplete.mockResolvedValue('the whole answer');
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        expect(mockModerateOutput).toHaveBeenCalledWith(GUILD, 'the whole answer');
    });
});

describe('a flagged reply is withheld', () => {
    test('the posted reply is the withheld notice, not the model text', async () => {
        mockComplete.mockResolvedValue('an unacceptable answer');
        mockModerateOutput.mockResolvedValue({ flagged: true, categories: ['hate'], model: 'omni' });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);

        const contents = everyPayload(message, sent);
        expect(contents.some(c => c.includes(WITHHELD))).toBe(true);
        expect(contents.some(c => c.includes('unacceptable'))).toBe(false);
    });

    test('the flagged reply is not written to history', async () => {
        mockComplete.mockResolvedValue('an unacceptable answer');
        mockModerateOutput.mockResolvedValue({ flagged: true, categories: [], model: 'omni' });
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        expect(mockAppendHistory).not.toHaveBeenCalled();
    });
});

describe('an unflagged reply is posted normally (fail-open)', () => {
    test('a null verdict leaves the answer as it is and stores it', async () => {
        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);

        const contents = everyPayload(message, sent);
        expect(contents.some(c => c.includes('a normal answer'))).toBe(true);
        expect(contents.some(c => c.includes(WITHHELD))).toBe(false);
        expect(mockAppendHistory).toHaveBeenCalled();
    });

    test('a passing verdict (flagged:false) also posts the answer', async () => {
        mockModerateOutput.mockResolvedValue({ flagged: false, categories: [], model: 'omni' });
        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        expect(everyPayload(message, sent).some(c => c.includes('a normal answer'))).toBe(true);
    });
});

describe('a guild that does not screen its output streams as before', () => {
    test('with moderation disabled the streaming path runs and nothing is withheld', async () => {
        mockOutputModerationEnabled.mockReturnValue(false);
        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);

        expect(mockStream).toHaveBeenCalled();
        expect(mockComplete).not.toHaveBeenCalled();
        expect(everyPayload(message, sent).some(c => c.includes(WITHHELD))).toBe(false);
    });
});
