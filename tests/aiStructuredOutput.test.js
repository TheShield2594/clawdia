'use strict';

// Provider-native structured output (#1044). Each provider gains a `structured`
// method that constrains the model's answer to a JSON schema — OpenAI Structured
// Outputs, Gemini `responseSchema`, Anthropic tool-forcing — and a
// `supportsStructured` the registry asks before choosing it over the
// prompt-and-parse fallback. These pin the request shape each one sends and the
// gating that keeps an unsupported provider off the native path.

const mockOpenAiCreate = jest.fn();
jest.mock('openai', () =>
    jest.fn().mockImplementation(() => ({
        chat: { completions: { create: mockOpenAiCreate } }
    }))
);

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
    jest.fn().mockImplementation(() => ({
        messages: { create: mockAnthropicCreate },
        beta: { messages: { create: mockAnthropicCreate } }
    }))
);

const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: class {
        constructor() {
            this.models = { generateContent: mockGenerateContent };
            this.chats = { create: jest.fn() };
        }
    }
}));

const openai = require('../src/services/ai/providers/openai');
const gemini = require('../src/services/ai/providers/gemini');
const anthropic = require('../src/services/ai/providers/anthropic');
const { supportsStructured } = require('../src/services/ai/providers');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string' },
        mechanic: { type: 'string', enum: ['hunt', 'fishing'] },
        target: { type: 'integer' }
    },
    required: ['name', 'mechanic', 'target']
};

const REQ = {
    apiKey: 'k',
    systemPrompt: 'be a quest narrator',
    history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    prompt: 'make a quest',
    temperature: 0.9,
    maxTokens: 800,
    schema: SCHEMA,
    schemaName: 'legendary_quest'
};

beforeEach(() => jest.clearAllMocks());

describe('supportsStructured gating', () => {
    test('OpenAI: the 4o/4.1/5 and o-series lines, but not o1-mini or the old base models', () => {
        for (const model of ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'o3-mini', 'o1']) {
            expect(openai.supportsStructured(model)).toBe(true);
        }
        for (const model of ['o1-mini', 'gpt-4', 'gpt-3.5-turbo', '']) {
            expect(openai.supportsStructured(model)).toBe(false);
        }
    });

    test('Gemini: 1.5-and-later chat models, but not retired 1.0 pro or the non-chat endpoints', () => {
        for (const model of ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']) {
            expect(gemini.supportsStructured(model)).toBe(true);
        }
        for (const model of ['gemini-pro', 'gemini-1.0-pro', 'text-embedding-004', 'imagen-3.0']) {
            expect(gemini.supportsStructured(model)).toBe(false);
        }
    });

    test('Anthropic: every Claude 3+ (a deny list), never the retired 2 line', () => {
        for (const model of ['claude-haiku-4-5', 'claude-sonnet-4', 'claude-3-5-sonnet', 'claude-9-future']) {
            expect(anthropic.supportsStructured(model)).toBe(true);
        }
        for (const model of ['claude-2', 'claude-2.1', 'claude-instant-1.2']) {
            expect(anthropic.supportsStructured(model)).toBe(false);
        }
    });

    test('the registry answers per provider, and false for one with no native support', () => {
        expect(supportsStructured('openai', 'gpt-4o-mini')).toBe(true);
        expect(supportsStructured('gemini', 'gemini-2.0-flash')).toBe(true);
        expect(supportsStructured('anthropic', 'claude-haiku-4-5')).toBe(true);
        // Ollama and OpenRouter route to arbitrary models — no guarantee to make.
        expect(supportsStructured('ollama', 'llama3.2')).toBe(false);
        expect(supportsStructured('openrouter', 'openai/gpt-4o-mini')).toBe(false);
        // An unknown provider name is not a crash, just an unsupported one.
        expect(supportsStructured('nope', 'x')).toBe(false);
    });
});

describe('openai.structured', () => {
    test('sends a strict json_schema response_format and no tools, and parses the reply', async () => {
        mockOpenAiCreate.mockResolvedValue({
            choices: [{ message: { content: '{"name":"The Deep Vein","mechanic":"mining","target":14}' } }],
            usage: { prompt_tokens: 20, completion_tokens: 8 }
        });

        const { data, usage } = await openai.structured({ ...REQ, model: 'gpt-4o-mini' });

        const body = mockOpenAiCreate.mock.calls[0][0];
        expect(body.response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'legendary_quest', strict: true, schema: SCHEMA }
        });
        expect(body).not.toHaveProperty('tools');
        expect(body.temperature).toBe(0.9);
        expect(data).toEqual({ name: 'The Deep Vein', mechanic: 'mining', target: 14 });
        expect(usage).toEqual({ inputTokens: 20, outputTokens: 8, cachedInputTokens: 0 });
    });

    test('throws on an explicit refusal rather than parsing empty content', async () => {
        mockOpenAiCreate.mockResolvedValue({
            choices: [{ message: { refusal: 'I cannot make that.', content: null } }]
        });

        await expect(openai.structured({ ...REQ, model: 'gpt-4o-mini' })).rejects.toThrow(/refused/);
    });
});

describe('gemini.structured', () => {
    test('sends responseMimeType and the converted schema, and parses the reply', async () => {
        mockGenerateContent.mockResolvedValue({
            text: '{"name":"Astral Drift","mechanic":"hunt","target":9}',
            usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 }
        });

        const { data, usage } = await gemini.structured({ ...REQ, model: 'gemini-2.0-flash' });

        const body = mockGenerateContent.mock.calls[0][0];
        expect(body.config.responseMimeType).toBe('application/json');
        // The schema goes through toGeminiSchema — types uppercased to the
        // OpenAPI subset, unknown keywords (additionalProperties) dropped.
        expect(body.config.responseSchema).toEqual(gemini.toGeminiSchema(SCHEMA));
        expect(body.config.responseSchema.type).toBe('OBJECT');
        expect(body.config.responseSchema.properties.mechanic.enum).toEqual(['hunt', 'fishing']);
        expect(data).toEqual({ name: 'Astral Drift', mechanic: 'hunt', target: 9 });
        expect(usage).toEqual({ inputTokens: 30, outputTokens: 10, cachedInputTokens: 0 });
    });
});

describe('anthropic.structured', () => {
    test('forces a single tool whose input_schema is the caller schema, and returns its input', async () => {
        mockAnthropicCreate.mockResolvedValue({
            content: [{ type: 'tool_use', name: 'legendary_quest', input: { name: 'Emberfall', mechanic: 'fishing', target: 7 } }],
            usage: { input_tokens: 15, output_tokens: 5 }
        });

        const { data, usage } = await anthropic.structured({ ...REQ, model: 'claude-haiku-4-5' });

        const body = mockAnthropicCreate.mock.calls[0][0];
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'legendary_quest' });
        expect(body.tools).toEqual([
            { name: 'legendary_quest', description: expect.any(String), input_schema: SCHEMA }
        ]);
        expect(data).toEqual({ name: 'Emberfall', mechanic: 'fishing', target: 7 });
        expect(usage).toEqual({ inputTokens: 15, outputTokens: 5, cachedInputTokens: 0 });
    });

    test('throws when the forced tool call is somehow absent', async () => {
        mockAnthropicCreate.mockResolvedValue({
            content: [{ type: 'text', text: 'hmm' }],
            usage: { input_tokens: 1, output_tokens: 1 }
        });

        await expect(anthropic.structured({ ...REQ, model: 'claude-haiku-4-5' })).rejects.toThrow(/did not return/);
    });
});
