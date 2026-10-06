'use strict';

// A turn's deadline and an abort signal stop the provider's own round loop, not
// only its tool calls (#1238). A delegated child the task has stopped waiting
// for would otherwise go on starting paid rounds whose answer nobody reads.

const mockToolkitFor = jest.fn();
const mockCall = jest.fn();
jest.mock('../src/services/ai/mcp/toolkit', () => ({
    ...jest.requireActual('../src/services/ai/mcp/toolkit'),
    toolkitFor: mockToolkitFor
}));

const mockOpenAiCreate = jest.fn();
jest.mock('openai', () => class {
    constructor() {
        this.chat = { completions: { create: mockOpenAiCreate } };
    }
});

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => class {
    constructor() {
        this.messages = { create: mockAnthropicCreate, stream: jest.fn() };
        this.beta = { messages: { create: jest.fn(), stream: jest.fn() } };
    }
});

const mockSendMessage = jest.fn();
const mockGetHistory = jest.fn();
const mockChatsCreate = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: class {
        constructor() { this.chats = { create: mockChatsCreate }; }
    }
}));

jest.mock('../src/services/ai/usage', () => ({ recordUsage: jest.fn(() => Promise.resolve()) }));

const openai = require('../src/services/ai/providers/openai');
const anthropic = require('../src/services/ai/providers/anthropic');
const gemini = require('../src/services/ai/providers/gemini');
const ollama = require('../src/services/ai/providers/ollama');
const { getCompletion } = require('../src/services/ai/index');
const { recordUsage } = require('../src/services/ai/usage');
const { offersTools, withUsage, prepareMcpToolkit } = jest.requireActual('../src/services/ai/mcp/toolkit');
const { installHttpMock } = require('./helpers/httpMock');
const { jsonResponse } = require('./helpers/fetchResponse');

let http;

const REQ = {
    apiKey: 'k',
    model: 'test-model',
    systemPrompt: 'You are Clawdia.',
    history: [],
    prompt: 'what changed in the repo?',
    temperature: 0.7,
    maxTokens: 512,
    mcpServers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }],
    // Anthropic's client route, so it runs the same loop as the others.
    mcpRoute: 'client'
};

// A toolkit whose clock the test controls.
let timeUp;
const TOOLKIT = {
    definitions: [{
        name: 'github__search_repositories',
        serverName: 'github',
        toolName: 'search_repositories',
        description: 'Search repositories',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        annotations: {},
        confirm: false
    }],
    servers: ['github'],
    call: mockCall,
    expired: () => timeUp
};

beforeEach(() => {
    jest.resetAllMocks();
    http = installHttpMock();
    timeUp = false;
    mockToolkitFor.mockResolvedValue(TOOLKIT);
    // The deadline passes while the first round's tool runs.
    mockCall.mockImplementation(async () => {
        timeUp = true;
        return 'clawdia, 3 open PRs';
    });
    recordUsage.mockReturnValue(Promise.resolve());
    mockGetHistory.mockReturnValue([{ role: 'user', parts: [{ text: 'earlier' }] }]);
    mockChatsCreate.mockImplementation(() => ({ sendMessage: mockSendMessage, getHistory: mockGetHistory }));
});

afterEach(() => jest.restoreAllMocks());

const aborted = () => {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
};

// ── Each provider, one tool round then out of time ───────────────────────────

describe('a turn whose time runs out between rounds', () => {
    test('openai answers once more with no tools, then stops', async () => {
        mockOpenAiCreate
            .mockResolvedValueOnce({
                choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'github__search_repositories', arguments: '{"q":"x"}' } }] } }],
                usage: { prompt_tokens: 10, completion_tokens: 2 }
            })
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Three open PRs.' } }], usage: { prompt_tokens: 20, completion_tokens: 3 } });

        const result = await openai.complete(REQ);

        expect(result.text).toBe('Three open PRs.');
        expect(mockOpenAiCreate).toHaveBeenCalledTimes(2);
        expect(mockOpenAiCreate.mock.calls[0][0].tools).toHaveLength(1);
        expect(mockOpenAiCreate.mock.calls[1][0].tools).toBeUndefined();
    });

    test('anthropic answers once more with no tools, then stops', async () => {
        mockAnthropicCreate
            .mockResolvedValueOnce({
                content: [{ type: 'tool_use', id: 'u1', name: 'github__search_repositories', input: { q: 'x' } }],
                usage: { input_tokens: 10, output_tokens: 2 }
            })
            .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Three open PRs.' }], usage: { input_tokens: 20, output_tokens: 3 } });

        const result = await anthropic.complete(REQ);

        expect(result.text).toBe('Three open PRs.');
        expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
        expect(mockAnthropicCreate.mock.calls[0][0].tools).toHaveLength(1);
        expect(mockAnthropicCreate.mock.calls[1][0].tools).toBeUndefined();
    });

    test('gemini rebuilds the chat with no tools for one last answer, then stops', async () => {
        mockSendMessage
            .mockResolvedValueOnce({ text: '', functionCalls: [{ name: 'github__search_repositories', args: { q: 'x' } }] })
            .mockResolvedValueOnce({ text: 'Three open PRs.' });

        const result = await gemini.complete(REQ);

        expect(result.text).toBe('Three open PRs.');
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
        expect(mockChatsCreate.mock.calls[0][0].config.tools).toHaveLength(1);
        expect(mockChatsCreate.mock.calls.at(-1)[0].config.tools).toBeUndefined();
    });

    test('ollama answers once more with no tools, then stops', async () => {
        http.post
            .mockResolvedValueOnce(jsonResponse({ message: { content: '', tool_calls: [{ function: { name: 'github__search_repositories', arguments: { q: 'x' } } }] } }))
            .mockResolvedValueOnce(jsonResponse({ message: { content: 'Three open PRs.' } }));

        const result = await ollama.complete({ ...REQ, baseUrl: 'http://localhost:11434' });

        expect(result.text).toBe('Three open PRs.');
        expect(http.post).toHaveBeenCalledTimes(2);
        expect(http.post.mock.calls[0][1].tools).toHaveLength(1);
        expect(http.post.mock.calls[1][1].tools).toBeUndefined();
    });
});

// ── An aborted turn ──────────────────────────────────────────────────────────

describe('a turn whose signal has fired', () => {
    test('starts no request on any provider', async () => {
        const signal = aborted();
        await expect(openai.complete({ ...REQ, signal })).rejects.toMatchObject({ name: 'AbortError' });
        await expect(anthropic.complete({ ...REQ, signal })).rejects.toMatchObject({ name: 'AbortError' });
        await expect(gemini.complete({ ...REQ, signal })).rejects.toMatchObject({ name: 'AbortError' });
        await expect(ollama.complete({ ...REQ, baseUrl: 'http://localhost:11434', signal })).rejects.toMatchObject({ name: 'AbortError' });

        expect(mockOpenAiCreate).not.toHaveBeenCalled();
        expect(mockAnthropicCreate).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(http.post).not.toHaveBeenCalled();
    });

    test('hands the signal to each SDK call, so one in flight is cancelled', async () => {
        const { signal } = new AbortController();
        mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
        mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        mockSendMessage.mockResolvedValue({ text: 'ok' });
        http.post.mockResolvedValue(jsonResponse({ message: { content: 'ok' } }));

        await openai.complete({ ...REQ, signal });
        await anthropic.complete({ ...REQ, signal });
        await gemini.complete({ ...REQ, signal });
        await ollama.complete({ ...REQ, baseUrl: 'http://localhost:11434', signal });

        expect(mockOpenAiCreate.mock.calls[0][1]).toEqual({ signal });
        expect(mockAnthropicCreate.mock.calls[0][1]).toEqual({ signal });
        // On the chat's config, since a per-message one would replace it.
        expect(mockChatsCreate.mock.calls[0][0].config.abortSignal).toBe(signal);
        // Combined with Ollama's own timeout, so it is a different object that
        // fires when this one does.
        const sent = http.post.mock.calls[0][2].signal;
        expect(sent.aborted).toBe(false);
    });

    test('a call without a signal is made exactly as before', async () => {
        mockOpenAiCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
        await openai.complete(REQ);
        expect(mockOpenAiCreate.mock.calls[0]).toHaveLength(1);
    });

    test('stops between rounds once the signal fires mid-turn', async () => {
        const controller = new AbortController();
        mockCall.mockImplementation(async () => {
            controller.abort();
            return 'result';
        });
        mockOpenAiCreate.mockResolvedValueOnce({
            choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'github__search_repositories', arguments: '{}' } }] } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 }
        });

        const error = await openai.complete({ ...REQ, signal: controller.signal }).catch(err => err);

        expect(error.name).toBe('AbortError');
        expect(mockOpenAiCreate).toHaveBeenCalledTimes(1);
        // The round that did come back was billed, and the error says so.
        expect(error.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
    });
});

// ── Usage of a cancelled turn ────────────────────────────────────────────────

describe('what a cancelled turn already spent', () => {
    test('getCompletion records it against the guild', async () => {
        const controller = new AbortController();
        mockCall.mockImplementation(async () => {
            controller.abort();
            return 'result';
        });
        mockOpenAiCreate.mockResolvedValueOnce({
            choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'github__search_repositories', arguments: '{}' } }] } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 }
        });

        await expect(getCompletion({ ...REQ, provider: 'openai', guildId: 'g1', toolBudget: null, signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });

        expect(recordUsage).toHaveBeenCalledWith('g1', 'openai', 'test-model', { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
    });

    test('an error that already carries a usage keeps its own', () => {
        const error = Object.assign(new Error('x'), { usage: { inputTokens: 1 } });
        expect(withUsage(error, { inputTokens: 99 }).usage).toEqual({ inputTokens: 1 });
        expect(withUsage(new Error('y'), null).usage).toBeUndefined();
    });
});

// ── The toolkit's clock ──────────────────────────────────────────────────────

describe('offersTools', () => {
    test('withholds tools on the last round and once the deadline has passed', () => {
        const live = { maxRounds: 3, expired: () => false };
        expect(offersTools(live, 0)).toBe(true);
        expect(offersTools(live, 2)).toBe(true);
        expect(offersTools(live, 3)).toBe(false);
        expect(offersTools({ maxRounds: 3, expired: () => true }, 1)).toBe(false);
        expect(offersTools(null, 0)).toBe(false);
    });

    test('a real toolkit reports its turn budget as spent', async () => {
        const toolkit = await prepareMcpToolkit([], {
            botTools: [{ name: 'noop', serverName: 'clawdia', toolName: 'noop', description: 'x', inputSchema: { type: 'object' }, run: async () => 'ok' }],
            botToolsOnly: true,
            turnBudgetMs: 0
        });
        expect(toolkit.expired()).toBe(true);
    });
});
