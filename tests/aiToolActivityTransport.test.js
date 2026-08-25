'use strict';

// What a Discord channel actually sees when the AI reply calls MCP tools.
//
// A tool round produces no text, so before this the message sat on "…" for as
// long as somebody else's HTTP request took, and the finished answer said
// nothing about where it came from. These cover the two things that changed:
// a line naming the tool while it runs, and a summary left on the reply — with
// neither of them leaking into the conversation history the model is given
// next time.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null }))
}));

jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async () => ({ entries: [], isBackground: false })),
    buildKnowledgeContext: jest.fn(() => '')
}));

const mockAppendHistory = jest.fn(async () => {});
jest.mock('../src/services/ai/history', () => ({
    loadHistory: jest.fn(async () => ({ messages: [] })),
    appendHistory: (...args) => mockAppendHistory(...args),
    clearHistory: jest.fn(async () => {})
}));

jest.mock('../src/services/ai/providers', () => ({
    providers: new Map([['mock', { name: 'mock', label: 'Mock' }]]),
    mcpMode: () => 'client'
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

const { handleAIChat } = require('../src/services/ai/discordChat');

const SETTINGS = { provider: 'mock', streaming: true, actionsEnabled: false, maxHistory: 20 };

function fakeMessage(content = 'what changed in the repo?') {
    const sent = [];
    const emit = text => {
        const msg = {
            content: typeof text === 'string' ? text : '',
            edit: jest.fn(async next => { msg.content = next; return msg; }),
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
            send: jest.fn(async text => emit(text)),
            sendTyping: jest.fn(async () => {})
        },
        reply: jest.fn(async text => emit(text))
    };
    return { message, sent };
}

const start = args => args.onToolEvent({ type: 'start', id: 1, server: 'github', tool: 'search_repositories' });
const end = args => args.onToolEvent({
    type: 'end', id: 1, server: 'github', tool: 'search_repositories', durationMs: 1200, ok: true
});

// Everything the message was edited to over the course of the reply, so a
// transient state — the status line — can be asserted on as well as the last.
const edits = msg => msg.edit.mock.calls.map(call => call[0]);

beforeEach(() => {
    jest.clearAllMocks();
});

describe('while a tool is running', () => {
    test('the reply says which tool it is waiting on', async () => {
        mockStream.mockImplementation(async function* (args) {
            start(args);
            yield 'Let me look.';
            end(args);
            yield ' Three open PRs.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(edits(sent[0])).toContain('Let me look.\n-# 🔧 github · search_repositories…');
    });

    test('the status is gone from the finished reply', async () => {
        mockStream.mockImplementation(async function* (args) {
            start(args);
            yield 'Let me look.';
            end(args);
            yield ' Three open PRs.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(sent[0].content).not.toContain('search_repositories…');
    });
});

describe('the summary on the finished reply', () => {
    test('names the tool that ran and how long it took', async () => {
        mockStream.mockImplementation(async function* (args) {
            start(args);
            end(args);
            yield 'Three open PRs.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(sent[0].content).toBe('Three open PRs.\n-# 🔧 github·search_repositories 1.2s');
    });

    test('is left off entirely when no tool ran', async () => {
        mockStream.mockImplementation(async function* () {
            yield 'Three open PRs.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(sent[0].content).toBe('Three open PRs.');
        expect(message.channel.send).not.toHaveBeenCalled();
    });

    test('reports a server that could not be reached, even with nothing called', async () => {
        mockStream.mockImplementation(async function* (args) {
            args.onToolEvent({ type: 'unavailable', server: 'github', error: 'HTTP 401' });
            yield 'I could not check.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(sent[0].content).toContain('⚠️ github unreachable');
    });

    test('never reaches the history the model is given next time', async () => {
        mockStream.mockImplementation(async function* (args) {
            start(args);
            end(args);
            yield 'Three open PRs.';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(mockAppendHistory).toHaveBeenCalledWith(
            'g1', 'c1', 'u1', 'what changed in the repo?', 'Three open PRs.', 20
        );
    });

    test('goes to its own message when the reply has no room left', async () => {
        const long = 'x'.repeat(1995);
        mockStream.mockImplementation(async function* (args) {
            start(args);
            end(args);
            yield long;
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(sent.at(-1).content).toBe('-# 🔧 github·search_repositories 1.2s');
        expect(sent.at(-1)).not.toBe(sent[0]);
    });

    test('a retried attempt reports its tools once, not twice', async () => {
        // withRetry restarts the whole stream, which runs the tools again — so
        // the record of them has to restart with it.
        let attempt = 0;
        mockStream.mockImplementation(async function* (args) {
            start(args);
            end(args);
            if (++attempt === 1) {
                const err = new Error('provider blew up');
                err.status = 500;
                throw err;
            }
            yield 'Three open PRs.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(attempt).toBe(2);
        expect(sent[0].content).toBe('Three open PRs.\n-# 🔧 github·search_repositories 1.2s');
    });
});

describe('without streaming', () => {
    test('the summary still lands on the reply', async () => {
        mockComplete.mockImplementation(async args => {
            start(args);
            end(args);
            return 'Three open PRs.';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, { ...SETTINGS, streaming: false });

        expect(sent[0].content).toBe('Three open PRs.\n-# 🔧 github·search_repositories 1.2s');
    });
});
