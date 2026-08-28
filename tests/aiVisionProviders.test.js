'use strict';

// #839, the wire half: the shape each provider puts an image in, and the
// promise that a model which cannot see is never sent one however the caller
// asks. Each provider filters the images itself, so the guarantee holds even
// if a future call site forgets to check first.

const mockOpenAiCreate = jest.fn(async () => ({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
}));
jest.mock('openai', () =>
    jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockOpenAiCreate } } }))
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

const mockGeminiSend = jest.fn(async () => ({ text: 'ok', functionCalls: [] }));
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        chats: { create: jest.fn(() => ({ sendMessage: mockGeminiSend, getHistory: () => [] })) }
    }))
}));

const mockAxiosPost = jest.fn(async () => ({
    data: { message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 }
}));
jest.mock('axios', () => ({ post: (...args) => mockAxiosPost(...args), get: jest.fn() }));

const openai = require('../src/services/ai/providers/openai');
const anthropic = require('../src/services/ai/providers/anthropic');
const gemini = require('../src/services/ai/providers/gemini');
const ollama = require('../src/services/ai/providers/ollama');
const openrouter = require('../src/services/ai/providers/openrouter');

const IMAGE = { mimeType: 'image/png', base64: 'QUJD', name: 'shot.png', url: 'https://cdn.discordapp.com/x.png' };

const baseReq = {
    apiKey: 'k',
    baseUrl: 'http://localhost:11434',
    systemPrompt: 'be helpful',
    history: [],
    prompt: "what's wrong with this?",
    temperature: 0.7,
    maxTokens: 500,
    useMcp: false,
    mcpServers: [],
    images: [IMAGE]
};

beforeEach(() => jest.clearAllMocks());

describe('OpenAI', () => {
    test('sends the text and then the image as a data URL', async () => {
        await openai.complete({ ...baseReq, model: 'gpt-4o-mini' });

        const content = mockOpenAiCreate.mock.calls[0][0].messages.at(-1).content;
        expect(content[0]).toEqual({ type: 'text', text: "what's wrong with this?" });
        expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    });

    test('a text-only model gets the plain string it always got', async () => {
        await openai.complete({ ...baseReq, model: 'o3-mini' });

        expect(mockOpenAiCreate.mock.calls[0][0].messages.at(-1).content).toBe("what's wrong with this?");
    });

    test('and a request with no images is unchanged', async () => {
        await openai.complete({ ...baseReq, model: 'gpt-4o-mini', images: [] });

        expect(mockOpenAiCreate.mock.calls[0][0].messages.at(-1).content).toBe("what's wrong with this?");
    });
});

describe('Anthropic', () => {
    test('sends a base64 image block rather than the CDN URL', async () => {
        await anthropic.complete({ ...baseReq, model: 'claude-haiku-4-5' });

        const content = mockAnthropicCreate.mock.calls[0][0].messages.at(-1).content;
        expect(content[1]).toEqual({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'QUJD' }
        });
    });

    test('a retired text-only model gets the plain string', async () => {
        await anthropic.complete({ ...baseReq, model: 'claude-2.1' });

        expect(mockAnthropicCreate.mock.calls[0][0].messages.at(-1).content).toBe("what's wrong with this?");
    });
});

describe('Gemini', () => {
    test('sends the image as an inlineData part', async () => {
        await gemini.complete({ ...baseReq, model: 'gemini-2.0-flash' });

        const message = mockGeminiSend.mock.calls[0][0].message;
        expect(message[0]).toEqual({ text: "what's wrong with this?" });
        expect(message[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'QUJD' } });
    });

    // The one format Gemini does not take. Dropping it for this provider beats
    // refusing it for all four.
    test('drops a GIF and keeps the rest of the message', async () => {
        await gemini.complete({
            ...baseReq,
            model: 'gemini-2.0-flash',
            images: [{ mimeType: 'image/gif', base64: 'R0lG' }]
        });

        expect(mockGeminiSend.mock.calls[0][0].message).toBe("what's wrong with this?");
    });
});

// OpenRouter routes another vendor's model through the OpenAI request path, so
// the two have to agree about whether the image goes. They did not: OpenRouter
// accepted `openai/gpt-4o-mini`, and the OpenAI adapter matched that id against
// its own model list, failed, and dropped the image — leaving the user a
// confident answer about a picture nothing had been shown.
describe('OpenRouter', () => {
    test('a routed OpenAI model keeps its image', async () => {
        await openrouter.complete({ ...baseReq, model: 'openai/gpt-4o-mini' });

        const content = mockOpenAiCreate.mock.calls[0][0].messages.at(-1).content;
        expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
    });

    // The id the OpenAI adapter could never judge for itself.
    test('and so does a routed model from another vendor entirely', async () => {
        await openrouter.complete({ ...baseReq, model: 'anthropic/claude-haiku-4-5' });

        expect(mockOpenAiCreate.mock.calls[0][0].messages.at(-1).content).toHaveLength(2);
    });

    test('a routed model with no vision is still sent the plain string', async () => {
        await openrouter.complete({ ...baseReq, model: 'meta-llama/llama-3.1-8b-instruct' });

        expect(mockOpenAiCreate.mock.calls[0][0].messages.at(-1).content).toBe("what's wrong with this?");
    });

    test('the model id itself is untouched — only the capability travels', async () => {
        await openrouter.complete({ ...baseReq, model: 'openai/gpt-4o-mini' });

        expect(mockOpenAiCreate.mock.calls[0][0].model).toBe('openai/gpt-4o-mini');
    });
});

describe('Ollama', () => {
    test('sends base64 alongside the content, which is how Ollama takes it', async () => {
        await ollama.complete({ ...baseReq, model: 'llava' });

        const user = mockAxiosPost.mock.calls[0][1].messages.at(-1);
        expect(user.content).toBe("what's wrong with this?");
        expect(user.images).toEqual(['QUJD']);
    });

    test('a model with no vision tower is never handed one', async () => {
        await ollama.complete({ ...baseReq, model: 'llama3.2' });

        expect(mockAxiosPost.mock.calls[0][1].messages.at(-1)).not.toHaveProperty('images');
    });
});
