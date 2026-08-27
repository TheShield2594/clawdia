'use strict';

// Per-provider request shaping (#822). The guild schema allows temperature
// 0–2 (OpenAI's range), but Anthropic rejects anything above 1 — a guild that
// tuned 1.3 for OpenAI and then switched provider must not get HTTP 400 on
// every message. And OpenAI's o-series reasoning models take
// max_completion_tokens and reject non-default temperature, so those requests
// need different knobs entirely.

const mockOpenAiCreate = jest.fn(async () => ({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
}));
jest.mock('openai', () =>
    jest.fn().mockImplementation(() => ({
        chat: { completions: { create: mockOpenAiCreate } }
    }))
);

const mockAnthropicCreate = jest.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn'
}));
jest.mock('@anthropic-ai/sdk', () =>
    jest.fn().mockImplementation(() => ({
        messages: { create: mockAnthropicCreate },
        beta: { messages: { create: mockAnthropicCreate } }
    }))
);

const openaiProvider = require('../src/services/ai/providers/openai');
const anthropicProvider = require('../src/services/ai/providers/anthropic');

const baseReq = {
    apiKey: 'k',
    systemPrompt: 'be helpful',
    history: [],
    prompt: 'hi',
    temperature: 1.3,
    maxTokens: 500,
    useMcp: false,
    mcpServers: []
};

beforeEach(() => jest.clearAllMocks());

describe('OpenAI o-series reasoning models', () => {
    test('send max_completion_tokens and no temperature', async () => {
        await openaiProvider.complete({ ...baseReq, model: 'o3-mini' });

        const body = mockOpenAiCreate.mock.calls[0][0];
        expect(body.max_completion_tokens).toBe(500);
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('max_tokens');
    });

    test('are recognized behind an OpenRouter-style prefix', async () => {
        await openaiProvider.complete({ ...baseReq, model: 'openai/o1' });

        const body = mockOpenAiCreate.mock.calls[0][0];
        expect(body.max_completion_tokens).toBe(500);
        expect(body).not.toHaveProperty('temperature');
    });

    test('dated snapshots of o-series models are shaped too', async () => {
        await openaiProvider.complete({ ...baseReq, model: 'o1-mini-2024-09-12' });

        expect(mockOpenAiCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    });
});

describe('OpenAI chat models', () => {
    test('keep the chat-model knobs', async () => {
        await openaiProvider.complete({ ...baseReq, model: 'gpt-4o-mini' });

        const body = mockOpenAiCreate.mock.calls[0][0];
        expect(body.temperature).toBe(1.3);
        expect(body.max_tokens).toBe(500);
        expect(body).not.toHaveProperty('max_completion_tokens');
    });

    test('gpt-4o is not mistaken for an o-series model', async () => {
        await openaiProvider.complete({ ...baseReq, model: 'gpt-4o' });

        expect(mockOpenAiCreate.mock.calls[0][0]).toHaveProperty('temperature', 1.3);
    });
});

describe('Anthropic temperature', () => {
    test('a value above 1 is clamped to 1 instead of 400ing', async () => {
        await anthropicProvider.complete({ ...baseReq, model: 'claude-haiku-4-5' });

        expect(mockAnthropicCreate.mock.calls[0][0].temperature).toBe(1);
    });

    test('a value already in range passes through unchanged', async () => {
        await anthropicProvider.complete({ ...baseReq, model: 'claude-haiku-4-5', temperature: 0.4 });

        expect(mockAnthropicCreate.mock.calls[0][0].temperature).toBe(0.4);
    });
});
