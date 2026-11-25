'use strict';

// A turn whose model came back with no text — typically one that ran out of
// reply budget partway through an apply_layout plan — used to leave only the
// tool footer (or the "…" placeholder) and nothing else. It now says so, and a
// turn offered the layout tools gets a reply budget big enough for a plan.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null }))
}));
jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async () => ({ entries: [], isBackground: false })),
    buildKnowledgeContext: jest.fn(() => '')
}));
jest.mock('../src/services/ai/history', () => ({
    loadHistory: jest.fn(async () => ({ messages: [] })),
    appendHistory: jest.fn(async () => {}),
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
let mockConfig = {};
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: () => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 1024,
        apiKey: 'k', baseUrl: null, mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 },
        ...mockConfig
    }),
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: (...args) => mockComplete(...args),
    DEFAULT_MODELS: { mock: 'mock-1' }
}));

const { PermissionFlagsBits } = require('discord.js');
const { handleAIChat } = require('../src/services/ai/discordChat');

const textOf = payload => (typeof payload === 'string' ? payload : payload?.content ?? '');

function fakeMessage({ manageChannels = false } = {}) {
    const sent = [];
    const emit = payload => {
        const msg = {
            content: textOf(payload),
            edit: jest.fn(async next => { msg.content = textOf(next); return msg; }),
            delete: jest.fn(async () => msg)
        };
        sent.push(msg);
        return msg;
    };
    const message = {
        content: 'redo the server layout',
        author: { id: 'u1' },
        guild: { id: 'g1', channels: { cache: new Map() }, roles: { cache: new Map() } },
        member: { permissions: { has: flag => manageChannels && flag === PermissionFlagsBits.ManageChannels } },
        channel: {
            id: 'c1',
            send: jest.fn(async payload => emit(payload)),
            sendTyping: jest.fn(async () => {})
        },
        reply: jest.fn(async payload => emit(payload))
    };
    return { message, sent };
}

beforeEach(() => { jest.clearAllMocks(); mockConfig = {}; });

test('a streamed turn with no text says so instead of leaving the placeholder', async () => {
    mockStream.mockImplementation(async function* () {});
    const { message, sent } = fakeMessage();
    await handleAIChat(message, { provider: 'mock', streaming: true, actionsEnabled: false, maxHistory: 20 });
    expect(sent[0].content).toMatch(/nothing to say/);
});

test('an unstreamed turn with no text says why rather than "(empty response)"', async () => {
    mockComplete.mockResolvedValue('');
    const { message, sent } = fakeMessage();
    await handleAIChat(message, { provider: 'mock', streaming: false, actionsEnabled: false, maxHistory: 20 });
    expect(sent.map(m => m.content).join('\n')).toMatch(/ran out of room/);
    // Shown, not kept: the note is not something the model said.
    expect(require('../src/services/ai/history').appendHistory).not.toHaveBeenCalled();
});

test('a whitespace-only completion counts as empty', async () => {
    mockComplete.mockResolvedValue(' \n ');
    const { message, sent } = fakeMessage();
    await handleAIChat(message, { provider: 'mock', streaming: false, actionsEnabled: false, maxHistory: 20 });
    expect(sent.map(m => m.content).join('\n')).toMatch(/ran out of room/);
    expect(require('../src/services/ai/history').appendHistory).not.toHaveBeenCalled();
});

test('the layout budget stops at a model\'s output ceiling', async () => {
    mockConfig = { provider: 'openai', model: 'gpt-4-turbo' };
    mockStream.mockImplementation(async function* () { yield 'ok'; });
    const { message } = fakeMessage({ manageChannels: true });
    await handleAIChat(message, { provider: 'mock', streaming: true, actionsEnabled: true, maxHistory: 20 });
    expect(mockStream.mock.calls[0][0].maxTokens).toBe(4096);
});

test('a turn offered apply_layout gets a reply budget big enough for a plan', async () => {
    mockStream.mockImplementation(async function* () { yield 'ok'; });
    const { message } = fakeMessage({ manageChannels: true });
    await handleAIChat(message, { provider: 'mock', streaming: true, actionsEnabled: true, maxHistory: 20 });
    const args = mockStream.mock.calls[0][0];
    expect(args.botTools.map(t => t.name)).toContain('apply_layout');
    expect(args.maxTokens).toBeGreaterThanOrEqual(8192);
});

test('a turn without the layout tools keeps the guild\'s own reply budget', async () => {
    mockStream.mockImplementation(async function* () { yield 'ok'; });
    const { message } = fakeMessage();
    await handleAIChat(message, { provider: 'mock', streaming: true, actionsEnabled: true, maxHistory: 20 });
    expect(mockStream.mock.calls[0][0].maxTokens).toBe(1024);
});
