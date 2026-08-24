'use strict';

// MCP for the providers that are not Anthropic. Anthropic hands its server list
// to the API and Claude does the rest; everything else needs the bot to run the
// loop — offer the tools, notice the calls, run them, send the results back —
// and that loop is what these cover, one provider at a time.

const mockToolkitFor = jest.fn();
const mockCall = jest.fn();

jest.mock('../src/services/ai/mcp/toolkit', () => ({
    ...jest.requireActual('../src/services/ai/mcp/toolkit'),
    toolkitFor: mockToolkitFor
}));

const mockCreate = jest.fn();
jest.mock('openai', () => class {
    constructor(options) {
        this.options = options;
        this.chat = { completions: { create: mockCreate } };
    }
});

jest.mock('axios');

const mockSendMessage = jest.fn();
const mockSendMessageStream = jest.fn();
const mockGetHistory = jest.fn(() => [{ role: 'user', parts: [{ text: 'earlier' }] }]);
const mockChatsCreate = jest.fn(() => ({
    sendMessage: mockSendMessage,
    sendMessageStream: mockSendMessageStream,
    getHistory: mockGetHistory
}));
jest.mock('@google/genai', () => ({
    GoogleGenAI: class {
        constructor() { this.chats = { create: mockChatsCreate }; }
    }
}));

const { Readable } = require('stream');
const axios = require('axios');
const openai = require('../src/services/ai/providers/openai');
const openrouter = require('../src/services/ai/providers/openrouter');
const ollama = require('../src/services/ai/providers/ollama');
const gemini = require('../src/services/ai/providers/gemini');
const { MAX_TOOL_ROUNDS } = require('../src/services/ai/mcp/toolkit');

const REQ = {
    apiKey: 'k',
    model: 'test-model',
    systemPrompt: 'You are Clawdia.',
    history: [],
    prompt: 'what changed in the repo?',
    temperature: 0.7,
    maxTokens: 512,
    mcpServers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }]
};

const TOOLKIT = {
    definitions: [{
        name: 'github__search_repositories',
        serverName: 'github',
        toolName: 'search_repositories',
        description: 'Search repositories',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], $schema: 'https://json-schema.org/draft/2020-12/schema' }
    }],
    servers: ['github'],
    call: mockCall
};

async function* iterate(items) {
    for (const item of items) yield item;
}

const collect = async iterable => {
    const out = [];
    for await (const piece of iterable) out.push(piece);
    return out;
};

beforeEach(() => {
    // reset, not clear: these tests queue one-shot responses, and a queue left
    // over from a case that consumed fewer than it queued would answer the next.
    jest.resetAllMocks();
    mockToolkitFor.mockResolvedValue(TOOLKIT);
    mockCall.mockResolvedValue('clawdia, 3 open PRs');
    mockGetHistory.mockReturnValue([{ role: 'user', parts: [{ text: 'earlier' }] }]);
    mockChatsCreate.mockImplementation(() => ({
        sendMessage: mockSendMessage,
        sendMessageStream: mockSendMessageStream,
        getHistory: mockGetHistory
    }));
});

// ── OpenAI (and, through it, OpenRouter) ────────────────────────────────────

function openAiChunk({ content, toolCall, usage }) {
    return {
        choices: [{
            delta: {
                ...(content ? { content } : {}),
                ...(toolCall ? { tool_calls: [toolCall] } : {})
            }
        }],
        ...(usage ? { usage } : {})
    };
}

const TOOL_CALL_STREAM = () => iterate([
    openAiChunk({ toolCall: { index: 0, id: 'call_1', function: { name: 'github__search_repositories', arguments: '{"q":' } } }),
    openAiChunk({ toolCall: { index: 0, function: { arguments: '"clawdia"}' } } }),
    openAiChunk({ usage: { prompt_tokens: 100, completion_tokens: 20 } })
]);

const ANSWER_STREAM = () => iterate([
    openAiChunk({ content: 'Three ' }),
    openAiChunk({ content: 'open PRs.' }),
    openAiChunk({ usage: { prompt_tokens: 300, completion_tokens: 10 } })
]);

describe('openai', () => {
    test('offers each MCP tool as a function', async () => {
        mockCreate.mockResolvedValueOnce(ANSWER_STREAM());
        await collect(openai.stream(REQ));

        expect(mockCreate.mock.calls[0][0].tools).toEqual([{
            type: 'function',
            function: {
                name: 'github__search_repositories',
                description: 'Search repositories',
                parameters: TOOLKIT.definitions[0].inputSchema
            }
        }]);
    });

    test('sends no tools field at all when there is nothing to offer', async () => {
        mockToolkitFor.mockResolvedValue(null);
        mockCreate.mockResolvedValueOnce(ANSWER_STREAM());

        await collect(openai.stream(REQ));
        expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tools');
    });

    test('runs a streamed tool call and asks again with the result', async () => {
        mockCreate
            .mockResolvedValueOnce(TOOL_CALL_STREAM())
            .mockResolvedValueOnce(ANSWER_STREAM());

        const pieces = await collect(openai.stream(REQ));

        // Arguments arrive split across deltas and have to be reassembled.
        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
        expect(pieces.join('')).toBe('Three open PRs.');

        const second = mockCreate.mock.calls[1][0].messages;
        expect(second.at(-2)).toEqual({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'github__search_repositories', arguments: '{"q":"clawdia"}' } }]
        });
        expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'clawdia, 3 open PRs' });
    });

    test('bills every round of a tool-calling turn, not just the last', async () => {
        mockCreate
            .mockResolvedValueOnce(TOOL_CALL_STREAM())
            .mockResolvedValueOnce(ANSWER_STREAM());

        const usageOut = {};
        await collect(openai.stream({ ...REQ, usageOut }));
        expect(usageOut.usage).toEqual({ inputTokens: 400, outputTokens: 30 });
    });

    test('withholds the tools on the last round so a turn cannot end mid-call', async () => {
        // A model that keeps calling tools would otherwise leave the user with
        // an empty message.
        for (let i = 0; i < MAX_TOOL_ROUNDS; i++) mockCreate.mockResolvedValueOnce(TOOL_CALL_STREAM());
        mockCreate.mockResolvedValueOnce(ANSWER_STREAM());

        await collect(openai.stream(REQ));

        expect(mockCreate).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
        expect(mockCreate.mock.calls[MAX_TOOL_ROUNDS - 1][0]).toHaveProperty('tools');
        expect(mockCreate.mock.calls[MAX_TOOL_ROUNDS][0]).not.toHaveProperty('tools');
    });

    test('hands malformed arguments back instead of dropping the call', async () => {
        mockCreate
            .mockResolvedValueOnce(iterate([
                openAiChunk({ toolCall: { index: 0, id: 'call_1', function: { name: 'github__search_repositories', arguments: '{"q":' } } })
            ]))
            .mockResolvedValueOnce(ANSWER_STREAM());

        await collect(openai.stream(REQ));

        expect(mockCall).not.toHaveBeenCalled();
        expect(mockCreate.mock.calls[1][0].messages.at(-1).content).toMatch(/not valid JSON/);
    });

    test('runs the same loop without streaming', async () => {
        mockCreate
            .mockResolvedValueOnce({
                choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'github__search_repositories', arguments: '{"q":"clawdia"}' } }] } }],
                usage: { prompt_tokens: 100, completion_tokens: 20 }
            })
            .mockResolvedValueOnce({
                choices: [{ message: { content: 'Three open PRs.' } }],
                usage: { prompt_tokens: 300, completion_tokens: 10 }
            });

        const result = await openai.complete(REQ);

        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
        expect(result).toEqual({ text: 'Three open PRs.', usage: { inputTokens: 400, outputTokens: 30 } });
    });

    test('passes the caller\'s mcp switch through to the toolkit', async () => {
        mockToolkitFor.mockResolvedValue(null);
        mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'x' } }] });

        await openai.complete({ ...REQ, useMcp: false });
        expect(mockToolkitFor).toHaveBeenCalledWith({ useMcp: false, mcpServers: REQ.mcpServers });
    });
});

describe('openrouter', () => {
    test('reaches the same tools through the OpenAI request path', async () => {
        mockCreate.mockResolvedValueOnce(ANSWER_STREAM());
        await collect(openrouter.stream({ ...REQ, model: 'openai/gpt-4o-mini' }));

        expect(mockCreate.mock.calls[0][0].tools).toHaveLength(1);
        expect(openrouter.mcp).toBe('client');
    });
});

// ── Ollama ──────────────────────────────────────────────────────────────────

function ndjson(lines) {
    return { data: Readable.from(lines.map(line => `${JSON.stringify(line)}\n`)) };
}

// Functions, not constants: a stream can only be read once.
const OLLAMA_TOOL_CALL = () => ndjson([
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'github__search_repositories', arguments: { q: 'clawdia' } } }] } },
    { done: true, prompt_eval_count: 100, eval_count: 20 }
]);

const OLLAMA_ANSWER = () => ndjson([
    { message: { content: 'Three open PRs.' } },
    { done: true, prompt_eval_count: 300, eval_count: 10 }
]);

describe('ollama', () => {
    test('offers the tools and feeds the result back as a tool message', async () => {
        axios.post
            .mockResolvedValueOnce(OLLAMA_TOOL_CALL())
            .mockResolvedValueOnce(OLLAMA_ANSWER());

        const pieces = await collect(ollama.stream({ ...REQ, baseUrl: 'http://localhost:11434' }));

        expect(axios.post.mock.calls[0][1].tools).toHaveLength(1);
        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
        expect(pieces.join('')).toBe('Three open PRs.');

        const second = axios.post.mock.calls[1][1].messages;
        expect(second.at(-1)).toEqual({
            role: 'tool',
            tool_name: 'github__search_repositories',
            content: 'clawdia, 3 open PRs'
        });
    });

    test('accepts arguments sent as JSON text as well as an object', async () => {
        axios.post
            .mockResolvedValueOnce(ndjson([
                { message: { tool_calls: [{ function: { name: 'github__search_repositories', arguments: '{"q":"clawdia"}' } }] } },
                { done: true }
            ]))
            .mockResolvedValueOnce(OLLAMA_ANSWER());

        await collect(ollama.stream({ ...REQ, baseUrl: 'http://localhost:11434' }));
        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
    });

    test('sums the token counts across rounds', async () => {
        axios.post
            .mockResolvedValueOnce(OLLAMA_TOOL_CALL())
            .mockResolvedValueOnce(OLLAMA_ANSWER());

        const usageOut = {};
        await collect(ollama.stream({ ...REQ, baseUrl: 'http://localhost:11434', usageOut }));
        expect(usageOut.usage).toEqual({ inputTokens: 400, outputTokens: 30 });
    });

    test('sends no tools field when there is nothing to offer', async () => {
        mockToolkitFor.mockResolvedValue(null);
        axios.post.mockResolvedValueOnce(OLLAMA_ANSWER());

        await collect(ollama.stream({ ...REQ, baseUrl: 'http://localhost:11434' }));
        expect(axios.post.mock.calls[0][1]).not.toHaveProperty('tools');
    });

    test('runs the same loop without streaming', async () => {
        axios.post
            .mockResolvedValueOnce({ data: { message: { content: '', tool_calls: [{ function: { name: 'github__search_repositories', arguments: { q: 'clawdia' } } }] }, prompt_eval_count: 100, eval_count: 20 } })
            .mockResolvedValueOnce({ data: { message: { content: 'Three open PRs.' }, prompt_eval_count: 300, eval_count: 10 } });

        const result = await ollama.complete({ ...REQ, baseUrl: 'http://localhost:11434' });
        expect(result).toEqual({ text: 'Three open PRs.', usage: { inputTokens: 400, outputTokens: 30 } });
    });
});

// ── Gemini ──────────────────────────────────────────────────────────────────

describe('gemini', () => {
    test('declares the tools as functions, in Gemini\'s schema dialect', async () => {
        mockSendMessage.mockResolvedValue({ text: 'ok' });
        await gemini.complete(REQ);

        expect(mockChatsCreate.mock.calls[0][0].config.tools).toEqual([{
            functionDeclarations: [{
                name: 'github__search_repositories',
                description: 'Search repositories',
                parameters: {
                    type: 'OBJECT',
                    required: ['q'],
                    properties: { q: { type: 'STRING' } }
                }
            }]
        }]);
    });

    test('answers a function call with a functionResponse part', async () => {
        mockSendMessage
            .mockResolvedValueOnce({
                text: '',
                functionCalls: [{ name: 'github__search_repositories', args: { q: 'clawdia' } }],
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }
            })
            .mockResolvedValueOnce({
                text: 'Three open PRs.',
                usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 10 }
            });

        const result = await gemini.complete(REQ);

        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
        expect(mockSendMessage.mock.calls[1][0]).toEqual({
            message: [{ functionResponse: { name: 'github__search_repositories', response: { result: 'clawdia, 3 open PRs' } } }]
        });
        expect(result).toEqual({ text: 'Three open PRs.', usage: { inputTokens: 400, outputTokens: 30 } });
    });

    test('collects function calls off the streamed chunks', async () => {
        mockSendMessageStream
            .mockResolvedValueOnce(iterate([
                { functionCalls: [{ name: 'github__search_repositories', args: { q: 'clawdia' } }] }
            ]))
            .mockResolvedValueOnce(iterate([
                { text: 'Three ' },
                { text: 'open PRs.', usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 10 } }
            ]));

        const pieces = await collect(gemini.stream(REQ));

        expect(mockCall).toHaveBeenCalled();
        expect(pieces.join('')).toBe('Three open PRs.');
    });

    test('takes the tools away for the last round rather than looping forever', async () => {
        const calling = {
            text: '',
            functionCalls: [{ name: 'github__search_repositories', args: { q: 'clawdia' } }]
        };
        for (let i = 0; i < MAX_TOOL_ROUNDS; i++) mockSendMessage.mockResolvedValueOnce(calling);
        mockSendMessage.mockResolvedValueOnce({ text: 'Three open PRs.' });

        const result = await gemini.complete(REQ);

        expect(result.text).toBe('Three open PRs.');
        // The last chat is rebuilt from the conversation so far, with no tools.
        const lastConfig = mockChatsCreate.mock.calls.at(-1)[0];
        expect(lastConfig.config.tools).toBeUndefined();
        expect(lastConfig.history).toEqual(mockGetHistory());
    });

    test('leaves the chat config alone when there are no tools', async () => {
        mockToolkitFor.mockResolvedValue(null);
        mockSendMessage.mockResolvedValue({ text: 'ok' });

        await gemini.complete(REQ);
        expect(mockChatsCreate.mock.calls[0][0].config).toEqual({
            systemInstruction: 'You are Clawdia.',
            temperature: 0.7,
            maxOutputTokens: 512
        });
    });
});

describe('gemini schema conversion', () => {
    const { toGeminiSchema } = gemini;

    test('drops the JSON Schema keys Gemini rejects', () => {
        expect(toGeminiSchema({
            type: 'object',
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            additionalProperties: false,
            properties: { q: { type: 'string', description: 'query' } }
        })).toEqual({
            type: 'OBJECT',
            properties: { q: { type: 'STRING', description: 'query' } }
        });
    });

    test('turns a nullable union into a type plus nullable', () => {
        expect(toGeminiSchema({ type: ['string', 'null'] })).toEqual({ type: 'STRING', nullable: true });
    });

    test('recurses into arrays and nested objects', () => {
        expect(toGeminiSchema({
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'integer' } } }
        })).toEqual({
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' } } }
        });
    });

    test('does not require a property it had to drop', () => {
        expect(toGeminiSchema({
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q', 'unsupported']
        })).toEqual({
            type: 'OBJECT',
            properties: { q: { type: 'STRING' } },
            required: ['q']
        });
    });

    test('sends nothing at all for a tool that takes no arguments', () => {
        expect(toGeminiSchema({ type: 'object', properties: {} })).toBeUndefined();
        expect(toGeminiSchema(undefined)).toBeUndefined();
    });
});
