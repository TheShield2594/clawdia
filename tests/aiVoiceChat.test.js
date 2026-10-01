'use strict';

// A voice message reaching the chat transport: answered from its transcript,
// or refused in words, and never transcribed for a guild that did not ask.

jest.mock('../src/models/User', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));
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
    supportsVision: () => false,
}));
jest.mock('../src/services/ai/transcription', () => ({
    ...jest.requireActual('../src/services/ai/transcription'),
    transcribeClip: jest.fn(),
}));

const mockComplete = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: () => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        apiKey: 'k', baseUrl: null, mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 },
    }),
    streamCompletion: jest.fn(),
    getCompletion: (...args) => mockComplete(...args),
    DEFAULT_MODELS: { mock: 'mock-1' },
}));

const { transcribeClip } = require('../src/services/ai/transcription');
const { appendHistory } = require('../src/services/ai/history');
const { handleAIChat } = require('../src/services/ai/discordChat');

const SETTINGS = { provider: 'mock', streaming: false, actionsEnabled: false, maxHistory: 20, voiceTranscription: true };
const CLIP = { url: 'https://cdn.discordapp.com/a/voice-message.ogg', name: 'voice-message.ogg', contentType: 'audio/ogg', size: 30_000, duration: 4 };

function voiceDm(content = '') {
    return {
        content,
        attachments: new Map([['1', CLIP]]),
        author: { id: 'u1' },
        guild: { id: 'g1' },
        channel: { id: 'dm1', send: jest.fn(async () => ({})), sendTyping: jest.fn(async () => {}) },
        reply: jest.fn(async payload => ({ payload, edit: jest.fn(), delete: jest.fn() })),
    };
}
const replyText = message => {
    const payload = message.reply.mock.calls.at(-1)?.[0];
    return typeof payload === 'string' ? payload : payload?.content ?? '';
};

beforeEach(() => {
    jest.clearAllMocks();
    mockComplete.mockResolvedValue('Done — reminder set for six.');
});

test('a voice-only message is answered from its transcript, which is also what history keeps', async () => {
    transcribeClip.mockResolvedValue({ text: 'remind me to call mum at six', service: 'OpenAI' });
    const message = voiceDm();

    await handleAIChat(message, SETTINGS, '');

    expect(transcribeClip).toHaveBeenCalledWith(expect.objectContaining({ url: CLIP.url, mimeType: 'audio/ogg' }), SETTINGS, 'g1');
    const prompt = mockComplete.mock.calls[0][0].prompt;
    expect(prompt).toBe('[Voice message, transcribed]\nremind me to call mum at six');
    expect(appendHistory.mock.calls[0][3]).toBe(prompt);
});

test('a clip that cannot be heard is answered with why, and no model call', async () => {
    transcribeClip.mockResolvedValue({ error: 'I could not make out anything in that voice message.' });
    const message = voiceDm();

    await handleAIChat(message, SETTINGS, '');

    expect(mockComplete).not.toHaveBeenCalled();
    expect(replyText(message)).toMatch(/could not make out/);
});

test('typed text beside an unheard clip is still answered', async () => {
    transcribeClip.mockResolvedValue({ error: 'nope' });
    await handleAIChat(voiceDm('what is the weather'), SETTINGS, 'what is the weather');
    expect(mockComplete.mock.calls[0][0].prompt).toBe('what is the weather');
});

test('a guild that has not switched it on is never transcribed for', async () => {
    const message = voiceDm();
    await handleAIChat(message, { ...SETTINGS, voiceTranscription: false }, '');

    expect(transcribeClip).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    expect(replyText(message)).toMatch(/did not ask anything/);
});

test('a clip that is too long is refused before anything is downloaded', async () => {
    const message = voiceDm();
    message.attachments = new Map([['1', { ...CLIP, duration: 3600 }]]);

    await handleAIChat(message, SETTINGS, '');

    expect(transcribeClip).not.toHaveBeenCalled();
    expect(replyText(message)).toMatch(/longer than 10 minutes/);
});
