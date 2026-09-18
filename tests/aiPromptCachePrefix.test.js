'use strict';

// #1046: the system prompt this transport assembles opens on a byte-stable
// prefix — the persona, the always-on background knowledge, the settings-derived
// tool rules — so every provider's prefix cache can hit across turns. The
// per-question sections (matched knowledge, the command and game tables the
// question retrieved, fetched documents) fall after it. This test drives the
// real transport twice with the same guild settings and knowledge base but a
// different question each time, and asserts the head of the prompt is identical.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null })),
    findOneAndUpdate: jest.fn(),
}));

// A fixed background entry every turn, and a matched entry that changes with the
// question — the two tiers #840 draws, here to prove only the always-on one is
// held in the cacheable prefix.
jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async (_guildId, content) => ({
        matched: [{ title: 'MATCH:' + content }],
        background: [{ title: 'BG-ENTRY' }],
    })),
    knowledgeSection: jest.fn((entries, opts) => ({
        header: opts?.background ? '\n\nBACKGROUND:' : '\n\nMATCHED:',
        joiner: ',',
        items: entries.map(e => e.title),
    })),
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

const PERSONA = 'You are Clawdia, keeper of this server.';
// A background entry is injected on every turn regardless of the question, and
// the persona and rules do not move — so the stable prefix is the persona
// followed by the rendered background block.
const STABLE_PREFIX = PERSONA + '\n\nBACKGROUND:BG-ENTRY';

const SETTINGS = { provider: 'mock', model: 'mock-1', streaming: false, actionsEnabled: false, maxHistory: 20, systemPrompt: PERSONA };

// The real command table so one question front-loads a per-question section the
// other does not — the tail differs while the prefix holds.
const HUNT = {
    category: 'economy',
    data: {
        toJSON: () => ({
            name: 'hunt',
            description: 'Hunt animals and manage gear',
            options: [{
                type: 2, name: 'inv', description: 'Manage your hunt inventory',
                options: [{
                    type: 1, name: 'equip', description: 'Equip a weapon by its inventory number',
                    options: [{ type: 4, name: 'number', required: true, description: 'Weapon number' }],
                }],
            }],
        }),
    },
};

function fakeMessage(content) {
    return {
        content,
        author: { id: 'u1' },
        guild: { id: 'g1' },
        member: { permissions: { has: () => false } },
        attachments: new Map(),
        channel: { id: 'c1', send: jest.fn(async () => ({})), sendTyping: jest.fn(async () => {}) },
        client: { commands: new Map([['hunt', HUNT]]) },
        reply: jest.fn(async payload => ({ payload, edit: jest.fn(), delete: jest.fn() })),
    };
}

const systemPromptSent = () => mockComplete.mock.calls.at(-1)?.[0]?.systemPrompt ?? '';

beforeEach(() => {
    jest.clearAllMocks();
    mockComplete.mockResolvedValue('an answer');
});

test('the same guild, two different questions, one identical prefix', async () => {
    await handleAIChat(fakeMessage('how do I equip my rifle'), SETTINGS, 'how do I equip my rifle');
    const first = systemPromptSent();

    await handleAIChat(fakeMessage('what does the cobalt rifle cost'), SETTINGS, 'what does the cobalt rifle cost');
    const second = systemPromptSent();

    // Both prompts open on the persona and the always-on background, byte for
    // byte — the precondition an automatic prefix cache needs to hit.
    expect(first.startsWith(STABLE_PREFIX)).toBe(true);
    expect(second.startsWith(STABLE_PREFIX)).toBe(true);

    // And it is genuinely two different questions: the per-question tail moved,
    // so the stability above is not just two identical prompts.
    expect(second).not.toBe(first);
    expect(first).toContain('MATCH:how do I equip my rifle');
    expect(second).toContain('MATCH:what does the cobalt rifle cost');
    // The matched, per-question knowledge is not in the shared prefix.
    expect(STABLE_PREFIX).not.toContain('MATCH:');
});

test('the matched knowledge never leaks into the cacheable prefix', async () => {
    await handleAIChat(fakeMessage('first question'), SETTINGS, 'first question');
    const prompt = systemPromptSent();

    // The background (always-on) comes before the matched block (per-question),
    // so the persona-plus-background head is settled before anything the
    // question pulled in.
    expect(prompt.indexOf('BACKGROUND:')).toBeLessThan(prompt.indexOf('MATCHED:'));
});
