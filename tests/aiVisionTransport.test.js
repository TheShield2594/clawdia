'use strict';

// The transport half of #839 and #840: what the Discord handler now assembles
// before it hands a turn to a provider.
//
//   - an attachment with no words is a question, not an empty prompt
//   - a model that cannot see is told so rather than left to guess
//   - the assembled prompt is measured against the model's context, and what
//     does not fit is dropped in priority order rather than by the far end
//   - only knowledge the question actually matched is cited as a source

jest.mock('../src/models/User', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));

const mockAxiosGet = jest.fn(async () => ({ data: Buffer.from('IMGBYTES') }));
jest.mock('axios', () => ({ get: (...args) => mockAxiosGet(...args) }));
jest.mock('../src/utils/outboundGuard', () => ({ guardedAgents: () => ({}), assertPublicHttpUrl: () => {} }));

const mockRetrieveKnowledge = jest.fn(async () => ({ entries: [], matched: [], background: [], isBackground: true }));
jest.mock('../src/services/ai/knowledge', () => {
    const actual = jest.requireActual('../src/services/ai/knowledge');
    return { ...actual, retrieveKnowledge: (...args) => mockRetrieveKnowledge(...args) };
});

const mockLoadHistory = jest.fn(async () => ({ messages: [], summary: null }));
jest.mock('../src/services/ai/history', () => ({
    loadHistory: (...args) => mockLoadHistory(...args),
    appendHistory: jest.fn(async () => {}),
    clearHistory: jest.fn(async () => {})
}));
jest.mock('../src/services/ai/summarize', () => ({
    createSummarizer: () => async () => null,
    summaryContext: () => []
}));
jest.mock('../src/services/ai/mcp/resources', () => ({ retrieveMcpKnowledge: jest.fn(async () => null) }));
jest.mock('../src/services/ai/mcp/usage', () => ({ recordToolCalls: jest.fn(async () => {}) }));

let mockVisionSupported = true;
jest.mock('../src/services/ai/providers', () => ({
    providers: new Map([['mock', { name: 'mock', label: 'Mock' }]]),
    mcpMode: () => null,
    usesClientTools: () => false,
    supportsVision: () => mockVisionSupported
}));

let mockProviderConfig;
const mockStream = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: () => mockProviderConfig,
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: jest.fn(async () => 'an answer'),
    DEFAULT_MODELS: { mock: 'mock-1' }
}));

const { handleAIChat } = require('../src/services/ai/discordChat');

const IMAGE = {
    url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
    contentType: 'image/png',
    name: 'shot.png',
    size: 2048
};

function chatMessage(content, attachments = []) {
    const sent = [];
    const editable = () => ({ edit: jest.fn(async () => {}), delete: jest.fn(async () => {}) });
    return {
        _sent: sent,
        content,
        attachments: new Map(attachments.map((a, i) => [String(i), a])),
        author: { id: 'author1' },
        guild: { id: 'guild1' },
        channel: {
            id: 'chan1',
            sendTyping: jest.fn(async () => {}),
            send: jest.fn(async payload => { sent.push(payload); return editable(); })
        },
        reply: jest.fn(async payload => { sent.push(payload); return editable(); })
    };
}

const settings = { streaming: true, systemPrompt: 'be helpful', maxHistory: 20 };
const callArgs = () => mockStream.mock.calls.at(-1)[0];

beforeEach(() => {
    jest.clearAllMocks();
    mockVisionSupported = true;
    mockProviderConfig = {
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        contextTokens: null, apiKey: 'k', baseUrl: null, mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 }
    };
    mockStream.mockImplementation(async function* () { yield 'an answer'; });
    mockRetrieveKnowledge.mockResolvedValue({ entries: [], matched: [], background: [], isBackground: true });
});

describe('an image on the message', () => {
    test('reaches the provider as bytes', async () => {
        await handleAIChat(chatMessage('what is wrong with this?', [IMAGE]), settings);

        expect(callArgs().images).toHaveLength(1);
        expect(callArgs().images[0]).toMatchObject({
            mimeType: 'image/png',
            base64: Buffer.from('IMGBYTES').toString('base64')
        });
    });

    // Before this, a screenshot with no caption was answered with "you
    // mentioned me but did not ask anything".
    test('is a question even with no words on it', async () => {
        const message = chatMessage('', [IMAGE]);

        await handleAIChat(message, settings);

        expect(mockStream).toHaveBeenCalled();
        expect(callArgs().prompt).toContain('no message text');
        expect(callArgs().images).toHaveLength(1);
    });

    test('and a message with neither words nor a picture still asks what they wanted', async () => {
        const message = chatMessage('');

        await handleAIChat(message, settings);

        expect(mockStream).not.toHaveBeenCalled();
        expect(message.reply.mock.calls[0][0].content).toContain('did not ask anything');
    });
});

describe('a model that cannot see', () => {
    beforeEach(() => { mockVisionSupported = false; });

    test('is not sent the image, and is not sent for it either', async () => {
        await handleAIChat(chatMessage('what is this?', [IMAGE]), settings);

        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(callArgs().images).toHaveLength(0);
    });

    test('is told the picture exists so it does not answer as though it saw one', async () => {
        await handleAIChat(chatMessage('what is this?', [IMAGE]), settings);

        expect(callArgs().systemPrompt).toContain('cannot read images');
        expect(callArgs().systemPrompt).toContain('cannot see it');
    });
});

describe('the assembled prompt', () => {
    test('is trimmed to the model context, oldest turns first', async () => {
        mockProviderConfig.contextTokens = 1024;
        mockProviderConfig.maxTokens = 256;
        mockLoadHistory.mockResolvedValue({
            messages: Array.from({ length: 20 }, (_, i) => ({
                role: i % 2 ? 'assistant' : 'user',
                content: `turn ${i} ${'x'.repeat(500)}`
            })),
            summary: null
        });

        await handleAIChat(chatMessage('and now?'), settings);

        const { history } = callArgs();
        expect(history.length).toBeLessThan(20);
        // What survives is the end of the conversation, and it opens on a user
        // turn — Anthropic rejects a conversation that opens on an assistant.
        expect(history.at(-1).content).toContain('turn 19');
        expect(history[0].role).toBe('user');
    });

    test('is left alone when it already fits', async () => {
        mockLoadHistory.mockResolvedValue({
            messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
            summary: null
        });

        await handleAIChat(chatMessage('and now?'), settings);

        expect(callArgs().history).toHaveLength(2);
        expect(callArgs().prompt).toBe('and now?');
    });

    test('drops background knowledge before the conversation', async () => {
        mockProviderConfig.contextTokens = 1024;
        mockProviderConfig.maxTokens = 256;
        mockRetrieveKnowledge.mockResolvedValue({
            entries: [{ _id: '1', title: 'Old note', content: 'y'.repeat(4000) }],
            matched: [],
            background: [{ _id: '1', title: 'Old note', content: 'y'.repeat(4000) }],
            isBackground: true
        });
        mockLoadHistory.mockResolvedValue({
            messages: [{ role: 'user', content: 'keep me' }, { role: 'assistant', content: 'kept' }],
            summary: null
        });

        await handleAIChat(chatMessage('and now?'), settings);

        expect(callArgs().systemPrompt).not.toContain('Old note');
        expect(callArgs().history).toHaveLength(2);
    });
});

describe('the sources footer', () => {
    const entry = (title, content = 'body') => ({ _id: title, title, content });

    test('names the entries the question matched', async () => {
        mockRetrieveKnowledge.mockResolvedValue({
            entries: [entry('Kitchen rota')],
            matched: [entry('Kitchen rota')],
            background: [],
            isBackground: false
        });

        const message = chatMessage('when is the kitchen rota?');
        await handleAIChat(message, settings);

        const footer = message._sent.map(s => s.content).find(c => typeof c === 'string' && c.startsWith('📚'));
        expect(footer).toContain('Kitchen rota');
    });

    // An entry that arrived by being recent answered nothing, so crediting it
    // would be an invented citation.
    test('says nothing about the background tier', async () => {
        mockRetrieveKnowledge.mockResolvedValue({
            entries: [entry('Server rules')],
            matched: [],
            background: [entry('Server rules')],
            isBackground: true
        });

        const message = chatMessage('what is the weather?');
        await handleAIChat(message, settings);

        expect(message._sent.some(s => typeof s.content === 'string' && s.content.startsWith('📚'))).toBe(false);
        // It is still in the prompt — it just is not a source.
        expect(callArgs().systemPrompt).toContain('Server rules');
    });
});
