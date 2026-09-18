'use strict';

// #1043: when outbound moderation flags the bot's own reply, the transport
// replaces it with a short withheld notice before it settles, keeps none of the
// flagged text (no tool footer, no attachments), and does not write it to the
// conversation history. A null verdict (off, no checker, or the check failed) is
// fail-open: the reply is posted exactly as it would be without the feature.

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
jest.mock('../src/services/aiOutputModerationService', () => ({
    moderateOutput: (...args) => mockModerateOutput(...args),
    outputModerationEnabled: jest.fn(() => true),
    WITHHELD_MESSAGE: WITHHELD,
}));

const { handleAIChat } = require('../src/services/ai/discordChat');

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
    return [...posts, ...edits];
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStream.mockImplementation(async function* () { yield 'a normal answer'; });
    mockComplete.mockResolvedValue('a normal answer');
    mockModerateOutput.mockResolvedValue(null); // fail-open default
});

describe('a flagged streaming reply is withheld', () => {
    test('the streamed text is redacted to the withheld notice', async () => {
        mockStream.mockImplementation(async function* () { yield 'here is how to do something awful'; });
        mockModerateOutput.mockResolvedValue({ flagged: true, categories: ['violence'], model: 'omni' });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);

        // Streaming posts as it generates, so the flagged text is briefly on
        // screen; what matters is the *final* state of every message — the notice
        // is shown and none of the flagged text is left behind.
        const finalContents = sent.map(m => (m.content ?? ''));
        expect(finalContents.some(c => c.includes(WITHHELD))).toBe(true);
        for (const text of finalContents) expect(text).not.toContain('awful');
    });

    test('the flagged reply is not written to history', async () => {
        mockModerateOutput.mockResolvedValue({ flagged: true, categories: [], model: 'omni' });
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        expect(mockAppendHistory).not.toHaveBeenCalled();
    });

    test('the moderation check is given the full generated reply and the guild', async () => {
        mockStream.mockImplementation(async function* () { yield 'the whole answer'; });
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        expect(mockModerateOutput).toHaveBeenCalledWith(GUILD, 'the whole answer');
    });
});

describe('a flagged non-streaming reply is withheld', () => {
    test('the posted reply is the withheld notice, not the model text', async () => {
        mockComplete.mockResolvedValue('an unacceptable answer');
        mockModerateOutput.mockResolvedValue({ flagged: true, categories: [], model: 'omni' });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, { ...SETTINGS, streaming: false }, 'hello', GUILD);

        const contents = everyPayload(message, sent).map(p => (typeof p === 'string' ? p : p?.content ?? ''));
        expect(contents.some(c => c.includes(WITHHELD))).toBe(true);
        expect(contents.some(c => c.includes('unacceptable'))).toBe(false);
        expect(mockAppendHistory).not.toHaveBeenCalled();
    });
});

describe('an unflagged reply is posted normally (fail-open)', () => {
    test('streaming: a null verdict leaves the answer as it is and stores it', async () => {
        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);

        const contents = everyPayload(message, sent).map(p => (typeof p === 'string' ? p : p?.content ?? ''));
        expect(contents.some(c => c.includes('a normal answer'))).toBe(true);
        expect(contents.some(c => c.includes(WITHHELD))).toBe(false);
        expect(mockAppendHistory).toHaveBeenCalled();
    });

    test('a passing verdict (flagged:false) also posts the answer', async () => {
        mockModerateOutput.mockResolvedValue({ flagged: false, categories: [], model: 'omni' });
        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS, 'hello', GUILD);
        const contents = everyPayload(message, sent).map(p => (typeof p === 'string' ? p : p?.content ?? ''));
        expect(contents.some(c => c.includes('a normal answer'))).toBe(true);
    });
});
