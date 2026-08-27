'use strict';

// A mid-stream retry starts the reply over on screen (#825). When a streamed
// reply overflows 2,000 chars the transport splits it into several Discord
// messages; a provider failure past a split boundary used to leave attempt
// 1's text in the earlier messages while attempt 2 painted only into the
// last one — a chimera of two different responses in the channel.

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
    mcpMode: () => 'client'
}));

const mockStream = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: () => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        apiKey: 'k', baseUrl: null, mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 }
    }),
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: jest.fn(),
    DEFAULT_MODELS: { mock: 'mock-1' }
}));

const { handleAIChat } = require('../src/services/ai/discordChat');

const SETTINGS = { provider: 'mock', streaming: true, actionsEnabled: false, maxHistory: 20 };

const textOf = payload => (typeof payload === 'string' ? payload : payload?.content ?? '');

function fakeMessage(content = 'tell me everything') {
    const sent = [];
    const emit = payload => {
        const msg = {
            content: textOf(payload),
            edit: jest.fn(async next => { msg.content = textOf(next); return msg; }),
            delete: jest.fn(async () => { msg.deleted = true; return msg; })
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

beforeEach(() => jest.clearAllMocks());

test('a retry after an overflow split deletes the stale split messages', async () => {
    // Attempt 1 crosses the split boundary, then the provider dies; attempt 2
    // answers briefly. The channel must end up showing only attempt 2.
    let attempts = 0;
    mockStream.mockImplementation(async function* () {
        if (++attempts === 1) {
            yield 'first attempt line\n'.repeat(150); // ~2850 chars: forces a split
            const err = new Error('provider blew up');
            err.status = 500;
            throw err;
        }
        yield 'Second answer.';
    });

    const { message, sent } = fakeMessage();
    await handleAIChat(message, SETTINGS);

    expect(attempts).toBe(2);
    // The placeholder carries the final answer…
    expect(sent[0].content).toBe('Second answer.');
    // …and every message attempt 1 overflowed into is gone.
    const extras = sent.slice(1);
    expect(extras.length).toBeGreaterThan(0);
    for (const extra of extras) expect(extra.deleted).toBe(true);
    // Nothing on screen still says what attempt 1 said.
    const visible = sent.filter(m => !m.deleted).map(m => m.content).join('');
    expect(visible).not.toContain('first attempt');
}, 15000);

test('an overflow split cuts at a newline, not mid-word at exactly the limit', async () => {
    const first = 'x'.repeat(1949);
    const second = 'y'.repeat(120);
    mockStream.mockImplementation(async function* () {
        yield first;            // sits just under the flush threshold
        yield `\n${second}`;    // pushes past it, with a newline in cutting range
    });

    const { message, sent } = fakeMessage();
    await handleAIChat(message, SETTINGS);

    expect(sent[0].content).toBe(first);
    expect(sent[1].content).toBe(second);
});
