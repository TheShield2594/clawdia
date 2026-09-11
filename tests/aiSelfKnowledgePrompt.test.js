'use strict';

// What the bot knows about itself reaching the model, rather than merely
// existing.
//
// tests/aiCommandHelp.test.js and tests/aiGameData.test.js cover what the two
// indexes find. This covers the wiring: that the chat transport asks both about
// the question, that what comes back is in the system prompt the provider is
// called with, and that a message about nothing in particular puts neither a
// command listing nor an item table in front of the model on every "hey".

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null })),
    findOneAndUpdate: jest.fn(),
}));
jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async () => ({ entries: [], matched: [], background: [], isBackground: true })),
    knowledgeSection: jest.fn(() => ({ header: '', joiner: '', items: [] })),
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

const { handleAIChat } = require('../src/services/ai/discordChat');

const SETTINGS = { provider: 'mock', streaming: false, actionsEnabled: false, maxHistory: 20 };

// The shape the loader produces: a builder that can render itself, and the
// category stamped on from the folder it came out of.
const HUNT = {
    category: 'economy',
    data: {
        toJSON: () => ({
            name: 'hunt',
            description: 'Hunt animals and manage gear',
            options: [{
                type: 2,
                name: 'inv',
                description: 'View and manage your hunt inventory',
                options: [{
                    type: 1,
                    name: 'equip',
                    description: 'Equip a weapon by its inventory number',
                    options: [{ type: 4, name: 'number', required: true, description: 'Weapon number' }],
                }],
            }],
        }),
    },
};

function fakeMessage(content, commands = new Map([['hunt', HUNT]])) {
    return {
        content,
        author: { id: 'u1' },
        guild: { id: 'g1' },
        member: { permissions: { has: () => false } },
        attachments: new Map(),
        channel: { id: 'c1', send: jest.fn(async () => ({})), sendTyping: jest.fn(async () => {}) },
        client: { commands },
        reply: jest.fn(async payload => ({ payload, edit: jest.fn(), delete: jest.fn() })),
    };
}

const systemPromptSent = () => mockComplete.mock.calls.at(-1)?.[0]?.systemPrompt ?? '';

beforeEach(() => {
    jest.clearAllMocks();
    mockComplete.mockResolvedValue('an answer');
});

test('the question this feature exists for reaches the model with its answer attached', async () => {
    await handleAIChat(fakeMessage('how do I equip my rifle'), SETTINGS, 'how do I equip my rifle');

    const prompt = systemPromptSent();
    expect(prompt).toContain('/hunt inv equip');
    expect(prompt).toContain('Equip a weapon by its inventory number');
    // And the rules that stop it being read as the whole command list.
    expect(prompt).toMatch(/never invent a command/i);
});

// The game tables are not mocked here: they are literals in src/data/, and the
// point of this one is that the real ones reach the real prompt.
test('a question about an item reaches the model with the item\'s own numbers', async () => {
    const ask = 'what does the cobalt rifle cost';
    await handleAIChat(fakeMessage(ask), SETTINGS, ask);

    const prompt = systemPromptSent();
    expect(prompt).toContain('**Cobalt Rifle**');
    expect(prompt).toContain('cost: 30,000');
    expect(prompt).toMatch(/never round or estimate/i);
});

test('a message about nothing in particular carries neither', async () => {
    await handleAIChat(fakeMessage('hey there, how are you today'), SETTINGS, 'hey there, how are you today');

    expect(mockComplete).toHaveBeenCalled();
    expect(systemPromptSent()).not.toContain('/hunt');
    expect(systemPromptSent()).not.toContain('Cobalt Rifle');
});

// The transport runs before the client has a command collection on it in some
// deployments, and a reply is worth more than a command reference.
test('a client with no commands loaded still answers', async () => {
    await handleAIChat(fakeMessage('how do I equip my rifle', null), SETTINGS, 'how do I equip my rifle');

    expect(mockComplete).toHaveBeenCalled();
    expect(systemPromptSent()).not.toContain('/hunt inv equip');
});
