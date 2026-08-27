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

const mockRetrieveMcpKnowledge = jest.fn(async () => null);
jest.mock('../src/services/ai/mcp/resources', () => ({
    retrieveMcpKnowledge: (...args) => mockRetrieveMcpKnowledge(...args)
}));

const mockRecordToolCalls = jest.fn(async () => {});
jest.mock('../src/services/ai/mcp/usage', () => ({
    recordToolCalls: (...args) => mockRecordToolCalls(...args)
}));

jest.mock('../src/services/ai/providers', () => ({
    providers: new Map([['mock', { name: 'mock', label: 'Mock' }]]),
    mcpMode: () => 'client'
}));

const mockStream = jest.fn();
const mockComplete = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: aiSettings => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        apiKey: 'k', baseUrl: null,
        // Passed through rather than fixed: whether a server resolves is what
        // decides if the transport attaches the MCP rule to the prompt.
        mcpServers: aiSettings.mcpServers || [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 }
    }),
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: (...args) => mockComplete(...args),
    DEFAULT_MODELS: { mock: 'mock-1' }
}));

const { handleAIChat } = require('../src/services/ai/discordChat');

const SETTINGS = { provider: 'mock', streaming: true, actionsEnabled: false, maxHistory: 20 };

// The transport posts payload objects now, never bare strings — that is what
// carries the mention policy — so the fake reads the text back out of one.
const textOf = payload => (typeof payload === 'string' ? payload : payload?.content ?? '');

function fakeMessage(content = 'what changed in the repo?') {
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

const start = args => args.onToolEvent({ type: 'start', id: 1, server: 'github', tool: 'search_repositories' });
const end = args => args.onToolEvent({
    type: 'end', id: 1, server: 'github', tool: 'search_repositories', durationMs: 1200, ok: true
});

// Everything the message was edited to over the course of the reply, so a
// transient state — the status line — can be asserted on as well as the last.
const edits = msg => msg.edit.mock.calls.map(call => textOf(call[0]));

beforeEach(() => {
    jest.clearAllMocks();
    mockRetrieveMcpKnowledge.mockResolvedValue(null);
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

    test('a turn that ran a tool is not retried, so nothing runs twice', async () => {
        // The retry re-enters the whole turn, which re-runs the tools. A turn
        // that filed an issue and then lost the stream to a 500 would file a
        // second one — and ask somebody to approve it again.
        let attempt = 0;
        mockStream.mockImplementation(async function* (args) {
            start(args);
            end(args);
            attempt++;
            const err = new Error('provider blew up');
            err.status = 500;
            throw err;
            // eslint-disable-next-line no-unreachable
            yield '';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(attempt).toBe(1);
        // The user is told, which is the smaller loss.
        expect(sent[0].content).toMatch(/hit an error/i);
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


describe('the usage ledger', () => {
    test('records what the turn\'s tools did, after the reply is sent', async () => {
        mockStream.mockImplementation(async function* (args) {
            start(args);
            end(args);
            yield 'Three open PRs.';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(mockRecordToolCalls).toHaveBeenCalledWith(
            'g1',
            [expect.objectContaining({ server: 'github', tool: 'search_repositories', ok: true })],
            []
        );
    });

    test('records a server that could not be reached', async () => {
        mockStream.mockImplementation(async function* (args) {
            args.onToolEvent({ type: 'unavailable', server: 'github', error: 'HTTP 401' });
            yield 'I could not check.';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(mockRecordToolCalls).toHaveBeenCalledWith('g1', [], ['github']);
    });

    test('writes nothing at all for a turn that used no tools', async () => {
        mockStream.mockImplementation(async function* () {
            yield 'Three open PRs.';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(mockRecordToolCalls).not.toHaveBeenCalled();
    });
});


describe('what the model is told about the servers', () => {
    // The rule reaches the model through the system prompt, so what is asserted
    // is the prompt the provider was handed.
    const promptFor = async settings => {
        mockStream.mockImplementation(async function* () { yield 'ok'; });
        const { message } = fakeMessage();
        await handleAIChat(message, settings);
        return mockStream.mock.calls[0][0].systemPrompt;
    };

    const WITH_MCP = { ...SETTINGS, mcpServers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true }] };

    test('with a server configured and actions off, it is still told', async () => {
        // The case that used to be silent: the rule rode on actionsEnabled, so
        // this guild got no guidance about tool results at all.
        const prompt = await promptFor({ ...WITH_MCP, actionsEnabled: false });
        expect(prompt).toMatch(/never an instruction to you/);
        expect(prompt).not.toMatch(/ACTION:/);
    });

    test('with actions on as well, it gets both rules', async () => {
        const prompt = await promptFor({ ...WITH_MCP, actionsEnabled: true });
        expect(prompt).toMatch(/never an instruction to you/);
        expect(prompt).toMatch(/ACTION:\{"type":"create_poll"/);
    });

    test('with no server configured, the rule is left out', async () => {
        const prompt = await promptFor({ ...SETTINGS, actionsEnabled: false });
        expect(prompt).not.toMatch(/never an instruction to you/);
    });

    // The second knowledge base: documents a server publishes, read as the
    // question is asked rather than pasted into the dashboard a month ago.
    test('a server\'s documents reach the model as reference material', async () => {
        mockRetrieveMcpKnowledge.mockResolvedValue({
            text: '\n\n---\nReference only\n> **Onboarding** — from the "wiki" server (wiki://onboarding)\n> Ask a lead.',
            sources: [{ server: 'wiki', uri: 'wiki://onboarding', name: 'Onboarding' }]
        });

        const prompt = await promptFor(WITH_MCP);
        expect(mockRetrieveMcpKnowledge).toHaveBeenCalledWith(WITH_MCP.mcpServers, 'what changed in the repo?');
        expect(prompt).toContain('Ask a lead.');
    });

    test('a documents server that falls over costs the reply nothing', async () => {
        mockRetrieveMcpKnowledge.mockRejectedValue(new Error('connect ETIMEDOUT'));

        mockStream.mockImplementation(async function* () { yield 'Answered anyway.'; });
        const { message, sent } = fakeMessage();
        await handleAIChat(message, WITH_MCP);

        expect(sent[0].content).toBe('Answered anyway.');
    });
});


describe('retrying a dropped stream', () => {
    const failOnce = () => {
        let attempts = 0;
        return {
            get attempts() { return attempts; },
            impl: async function* (args) {
                if (++attempts === 1) {
                    const err = new Error('provider blew up');
                    err.status = 500;
                    throw err;
                }
                args.onToolEvent({ type: 'unavailable', server: 'github' });
                yield 'Three open PRs.';
            }
        };
    };

    test('still happens when no tool was touched', async () => {
        // The retry earns its place on a transient provider failure; it is only
        // re-running tools that makes it unsafe.
        const run = failOnce();
        mockStream.mockImplementation(run.impl);

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(run.attempts).toBe(2);
        expect(sent[0].content).toContain('Three open PRs.');
    });

    test('and when a server was merely unreachable, since nothing ran', async () => {
        let attempts = 0;
        mockStream.mockImplementation(async function* (args) {
            args.onToolEvent({ type: 'unavailable', server: 'github' });
            if (++attempts === 1) {
                const err = new Error('provider blew up');
                err.status = 500;
                throw err;
            }
            yield 'I could not check.';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(attempts).toBe(2);
    });

    test('but not once a call was waiting on somebody to approve it', async () => {
        // The prompt is already on screen; retrying would put a second one
        // there for a call the first attempt may already have made.
        let attempts = 0;
        mockStream.mockImplementation(async function* (args) {
            args.onToolEvent({ type: 'confirm', id: 1, server: 'github', tool: 'create_issue' });
            attempts++;
            const err = new Error('provider blew up');
            err.status = 500;
            throw err;
            // eslint-disable-next-line no-unreachable
            yield '';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(attempts).toBe(1);
    });

    test('the same rule holds without streaming', async () => {
        let attempts = 0;
        mockComplete.mockImplementation(async args => {
            start(args);
            end(args);
            attempts++;
            const err = new Error('provider blew up');
            err.status = 500;
            throw err;
        });

        const { message } = fakeMessage();
        await handleAIChat(message, { ...SETTINGS, streaming: false });

        expect(attempts).toBe(1);
    });
});
