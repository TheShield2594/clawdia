'use strict';

// Wiring test for the Anthropic side of aiService: the MCP connector needs the
// server list, the matching toolsets and the beta flag to travel together on
// every request, and paused turns have to be resumed rather than truncated.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@anthropic-ai/sdk', () => {
    const create = jest.fn();
    const stream = jest.fn();
    class MockAnthropic {
        constructor(options) {
            MockAnthropic.lastConstructorOptions = options;
            this.messages = { create, stream };
        }
    }
    MockAnthropic.__create = create;
    MockAnthropic.__stream = stream;
    return MockAnthropic;
});

const Anthropic = require('@anthropic-ai/sdk');
const { loadMcpServers } = require('../src/config/mcpServers');
const { getCompletion, streamCompletion } = require('../src/services/aiService');

const create = Anthropic.__create;
const streamFn = Anthropic.__stream;

let tmpDir;
const originalEnv = process.env.MCP_SERVERS_CONFIG;

const BASE = {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: 'sk-ant-test',
    systemPrompt: 'You are Clawdia.',
    history: [],
    prompt: 'hello',
    temperature: 0.7,
    maxTokens: 512
};

function configureServers(servers) {
    const file = path.join(tmpDir, `mcp-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ servers }));
    process.env.MCP_SERVERS_CONFIG = file;
    loadMcpServers({ reload: true });
}

function reply(content, { stopReason = 'end_turn', usage = { input_tokens: 10, output_tokens: 5 } } = {}) {
    return { content, stop_reason: stopReason, usage };
}

function fakeStream(events, final) {
    return {
        [Symbol.asyncIterator]: async function* () {
            for (const event of events) yield event;
        },
        finalMessage: async () => final
    };
}

function textDelta(text) {
    return { type: 'content_block_delta', delta: { type: 'text_delta', text } };
}

async function collect(iterator) {
    const out = [];
    for await (const chunk of iterator) out.push(chunk);
    return out;
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-ai-mcp-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    create.mockReset();
    streamFn.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    configureServers([]);
});

afterEach(() => {
    jest.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.MCP_SERVERS_CONFIG;
    else process.env.MCP_SERVERS_CONFIG = originalEnv;
});

describe('getCompletion — anthropic', () => {
    test('sends no MCP fields when no servers are configured', async () => {
        create.mockResolvedValue(reply([{ type: 'text', text: 'hi' }]));

        await expect(getCompletion({ ...BASE })).resolves.toBe('hi');

        const [body, options] = create.mock.calls[0];
        expect(body).not.toHaveProperty('mcp_servers');
        expect(body).not.toHaveProperty('tools');
        expect(options).toBeUndefined();
    });

    test('sends every configured server with its toolset and the beta flag', async () => {
        configureServers([
            { name: 'one', url: 'https://one.example.com/sse', authorization_token: 'tok-1' },
            { name: 'two', url: 'https://two.example.com/sse' }
        ]);
        create.mockResolvedValue(reply([{ type: 'text', text: 'done' }]));

        await getCompletion({ ...BASE });

        const [body, options] = create.mock.calls[0];
        expect(body.mcp_servers).toEqual([
            { type: 'url', url: 'https://one.example.com/sse', name: 'one', authorization_token: 'tok-1' },
            { type: 'url', url: 'https://two.example.com/sse', name: 'two' }
        ]);
        expect(body.tools).toEqual([
            { type: 'mcp_toolset', mcp_server_name: 'one' },
            { type: 'mcp_toolset', mcp_server_name: 'two' }
        ]);
        expect(options).toEqual({ headers: { 'anthropic-beta': 'mcp-client-2025-11-20' } });
    });

    test('mcp: false opts a caller out even when servers are configured', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        create.mockResolvedValue(reply([{ type: 'text', text: '{}' }]));

        await getCompletion({ ...BASE, mcp: false });

        const [body, options] = create.mock.calls[0];
        expect(body).not.toHaveProperty('mcp_servers');
        expect(options).toBeUndefined();
    });

    test('leaves the other providers alone', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        const axios = require('axios');
        jest.spyOn(axios, 'post').mockResolvedValue({ data: { message: { content: 'local' } } });

        await expect(getCompletion({ ...BASE, provider: 'ollama', baseUrl: 'http://localhost:11434' }))
            .resolves.toBe('local');

        const [, body] = axios.post.mock.calls[0];
        expect(body).not.toHaveProperty('mcp_servers');
        expect(create).not.toHaveBeenCalled();
    });

    test('returns only the text, not the MCP tool traffic around it', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        create.mockResolvedValue(reply([
            { type: 'text', text: 'Looked it up: ' },
            { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'search', server_name: 'one', input: { q: 'x' } },
            { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', is_error: false, content: [{ type: 'text', text: 'RAW' }] },
            { type: 'text', text: 'all clear.' }
        ]));

        await expect(getCompletion({ ...BASE })).resolves.toBe('Looked it up: all clear.');
    });

    test('resumes a paused turn and adds up the usage across it', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        const paused = reply(
            [{ type: 'text', text: 'working' }],
            { stopReason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 4 } }
        );
        create
            .mockResolvedValueOnce(paused)
            .mockResolvedValueOnce(reply([{ type: 'text', text: ' — done' }], { usage: { input_tokens: 20, output_tokens: 6 } }));

        await expect(getCompletion({ ...BASE })).resolves.toBe('working — done');

        expect(create).toHaveBeenCalledTimes(2);
        // The paused turn is handed back verbatim so the server can pick it up.
        const secondMessages = create.mock.calls[1][0].messages;
        expect(secondMessages).toHaveLength(2);
        expect(secondMessages[1]).toEqual({ role: 'assistant', content: paused.content });
    });

    test('gives up after a bounded number of continuations', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        create.mockResolvedValue(reply([{ type: 'text', text: '.' }], { stopReason: 'pause_turn' }));

        await expect(getCompletion({ ...BASE })).resolves.toBe('....');
        expect(create).toHaveBeenCalledTimes(4);
    });
});

describe('streamCompletion — anthropic', () => {
    test('streams text deltas and carries the MCP request fields', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        streamFn.mockReturnValue(fakeStream(
            [
                { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } },
                textDelta('Hel'),
                textDelta('lo'),
                { type: 'message_delta', usage: { output_tokens: 7 } }
            ],
            { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello' }] }
        ));

        const usageOut = {};
        const chunks = await collect(streamCompletion({ ...BASE, usageOut }));

        expect(chunks.join('')).toBe('Hello');
        expect(usageOut.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

        const [body, options] = streamFn.mock.calls[0];
        expect(body.mcp_servers).toHaveLength(1);
        expect(body.tools).toEqual([{ type: 'mcp_toolset', mcp_server_name: 'one' }]);
        expect(options).toEqual({ headers: { 'anthropic-beta': 'mcp-client-2025-11-20' } });
    });

    test('resumes a paused stream so the reply is not cut short', async () => {
        configureServers([{ name: 'one', url: 'https://one.example.com/sse' }]);
        const pausedContent = [{ type: 'text', text: 'searching' }];
        streamFn
            .mockReturnValueOnce(fakeStream(
                [
                    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
                    textDelta('searching'),
                    { type: 'message_delta', usage: { output_tokens: 3 } }
                ],
                { stop_reason: 'pause_turn', content: pausedContent }
            ))
            .mockReturnValueOnce(fakeStream(
                [
                    { type: 'message_start', message: { usage: { input_tokens: 15, output_tokens: 0 } } },
                    textDelta('… found it'),
                    { type: 'message_delta', usage: { output_tokens: 4 } }
                ],
                { stop_reason: 'end_turn', content: [{ type: 'text', text: '… found it' }] }
            ));

        const usageOut = {};
        const chunks = await collect(streamCompletion({ ...BASE, usageOut }));

        expect(chunks.join('')).toBe('searching… found it');
        expect(usageOut.usage).toEqual({ inputTokens: 25, outputTokens: 7 });
        expect(streamFn.mock.calls[1][0].messages.at(-1)).toEqual({ role: 'assistant', content: pausedContent });
    });
});
