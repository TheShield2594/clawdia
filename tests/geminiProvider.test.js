'use strict';

// The Gemini provider, after the move from the retired `@google/generative-ai`
// package to Google's current `@google/genai`. Every shape in the call path
// changed — the constructor, how a chat is created, where the generation config
// lives, whether `text` is a method or a getter, and where streaming usage
// comes from — so these tests pin the ones the ledger and the Discord transport
// depend on.

const mockSendMessage = jest.fn();
const mockSendMessageStream = jest.fn();
const mockChatsCreate = jest.fn(() => ({ sendMessage: mockSendMessage, sendMessageStream: mockSendMessageStream }));
const mockConstructed = [];

jest.mock('@google/genai', () => ({
    GoogleGenAI: class {
        constructor(options) {
            mockConstructed.push(options);
            this.chats = { create: mockChatsCreate };
        }
    },
}));

const gemini = require('../src/services/ai/providers/gemini');

const REQ = {
    apiKey: 'gemini-key',
    model: 'gemini-2.0-flash',
    systemPrompt: 'You are a helpful bot.',
    history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
    ],
    prompt: 'what is the weather?',
    temperature: 0.7,
    maxTokens: 512,
};

const USAGE = { promptTokenCount: 40, candidatesTokenCount: 12 };

async function* chunks(...items) {
    for (const item of items) yield item;
}

const collect = async iterable => {
    const out = [];
    for await (const piece of iterable) out.push(piece);
    return out;
};

beforeEach(() => {
    mockConstructed.length = 0;
    jest.clearAllMocks();
    mockChatsCreate.mockImplementation(() => ({ sendMessage: mockSendMessage, sendMessageStream: mockSendMessageStream }));
});

describe('chat setup', () => {
    it('passes the key as an options object, not a positional argument', async () => {
        mockSendMessage.mockResolvedValue({ text: 'ok' });
        await gemini.complete(REQ);
        expect(mockConstructed).toEqual([{ apiKey: 'gemini-key' }]);
    });

    it('puts the system prompt and generation settings in one config block', async () => {
        mockSendMessage.mockResolvedValue({ text: 'ok' });
        await gemini.complete(REQ);

        expect(mockChatsCreate).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-2.0-flash',
            config: {
                systemInstruction: 'You are a helpful bot.',
                temperature: 0.7,
                maxOutputTokens: 512,
            },
        }));
    });

    it('renames the assistant role to Gemini\'s "model"', async () => {
        mockSendMessage.mockResolvedValue({ text: 'ok' });
        await gemini.complete(REQ);

        expect(mockChatsCreate.mock.calls[0][0].history).toEqual([
            { role: 'user', parts: [{ text: 'hello' }] },
            { role: 'model', parts: [{ text: 'hi there' }] },
        ]);
    });

    it('sends the prompt as a named message parameter', async () => {
        mockSendMessage.mockResolvedValue({ text: 'ok' });
        await gemini.complete(REQ);
        expect(mockSendMessage).toHaveBeenCalledWith({ message: 'what is the weather?' });
    });
});

describe('complete', () => {
    it('reads text from the getter, not a text() call', async () => {
        mockSendMessage.mockResolvedValue({ text: 'sunny', usageMetadata: USAGE });
        const result = await gemini.complete(REQ);
        expect(result.text).toBe('sunny');
        expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
    });

    it('returns an empty string when the model produced no text part', async () => {
        // A safety block leaves `.text` undefined; the transports concatenate
        // and .trim() what comes back, so undefined would throw there.
        mockSendMessage.mockResolvedValue({ text: undefined, usageMetadata: USAGE });
        expect((await gemini.complete(REQ)).text).toBe('');
    });

    it('reports no usage rather than zeros when the response carried none', async () => {
        mockSendMessage.mockResolvedValue({ text: 'sunny' });
        expect((await gemini.complete(REQ)).usage).toBeNull();
    });
});

describe('stream', () => {
    it('iterates the awaited return value directly, not a .stream property', async () => {
        mockSendMessageStream.mockResolvedValue(chunks({ text: 'su' }, { text: 'nny' }));
        expect(await collect(gemini.stream(REQ))).toEqual(['su', 'nny']);
        expect(mockSendMessageStream).toHaveBeenCalledWith({ message: 'what is the weather?' });
    });

    it('takes usage off the chunks, where the new SDK puts it', async () => {
        // The old SDK exposed it on a separate response object awaited after
        // the stream; there is no such object now.
        const usageOut = {};
        mockSendMessageStream.mockResolvedValue(chunks(
            { text: 'su' },
            { text: 'nny', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 2 } },
        ));

        await collect(gemini.stream({ ...REQ, usageOut }));
        expect(usageOut.usage).toEqual({ inputTokens: 40, outputTokens: 2 });
    });

    it('keeps the last running total when several chunks carry usage', async () => {
        const usageOut = {};
        mockSendMessageStream.mockResolvedValue(chunks(
            { text: 'a', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 1 } },
            { text: 'b', usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 } },
        ));

        await collect(gemini.stream({ ...REQ, usageOut }));
        expect(usageOut.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
    });

    it('leaves usage unset when no chunk carried any, so nothing bogus is billed', async () => {
        const usageOut = {};
        mockSendMessageStream.mockResolvedValue(chunks({ text: 'sunny' }));
        await collect(gemini.stream({ ...REQ, usageOut }));
        expect(usageOut.usage).toBeUndefined();
    });

    it('skips empty chunks instead of yielding blanks', async () => {
        mockSendMessageStream.mockResolvedValue(chunks({ text: '' }, { text: 'x' }, { text: undefined }));
        expect(await collect(gemini.stream(REQ))).toEqual(['x']);
    });
});

describe('registration', () => {
    it('is still the same provider from the registry\'s point of view', () => {
        expect(gemini.name).toBe('gemini');
        expect(gemini.label).toBe('Gemini');
        expect(gemini.defaultModel).toBe('gemini-2.0-flash');
        expect(typeof gemini.resolveAuth).toBe('function');
    });

    it('resolves the key from settings first, then the environment', () => {
        const saved = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = 'from-env';
        try {
            expect(gemini.resolveAuth({ geminiKey: 'from-settings' }).apiKey).toBe('from-settings');
            expect(gemini.resolveAuth({}).apiKey).toBe('from-env');
        } finally {
            if (saved === undefined) delete process.env.GEMINI_API_KEY;
            else process.env.GEMINI_API_KEY = saved;
        }
    });

    it('is not importing the retired package anywhere', () => {
        const fs = require('fs');
        const path = require('path');
        const SRC = path.join(__dirname, '..', 'src');
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(path.join(dir, e.name))
                : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);

        // Requires only — the provider's own comment names the old package to
        // explain what moved, and that is worth keeping.
        const stragglers = walk(SRC).filter(f =>
            /require\(['"]@google\/generative-ai['"]\)/.test(fs.readFileSync(f, 'utf8')));
        expect(stragglers).toEqual([]);
        expect(require('../package.json').dependencies['@google/generative-ai']).toBeUndefined();
    });
});
