'use strict';

// Backup providers (`ai.fallbacks`): when the primary cannot answer, the next
// one does — but never after a reply has started, never after a tool ran, and
// never for a request that is simply wrong.

jest.mock('../src/models/AIUsage', () => ({ find: jest.fn(() => ({ lean: async () => [] })), updateOne: jest.fn(async () => {}) }));
jest.mock('../src/services/ai/usage', () => ({
    ...jest.requireActual('../src/services/ai/usage'),
    recordUsage: jest.fn(async () => {}),
}));

jest.mock('../src/services/ai/providers', () => {
    const make = (name, auth = { apiKey: `${name}-key`, keySource: 'guild' }) => ({
        name, label: name, defaultModel: `${name}-default`,
        resolveAuth: jest.fn(() => auth),
        complete: jest.fn(async () => ({ text: `${name} answered`, usage: { input: 1, output: 1 } })),
        stream: jest.fn(async function* () { yield `${name} `; yield 'streamed'; }),
    });
    const providers = new Map([
        ['openai', make('openai')],
        ['gemini', make('gemini')],
        ['anthropic', make('anthropic', { apiKey: null, keySource: null })],
        ['openrouter', make('openrouter', { apiKey: 'env-key', keySource: 'env' })],
    ]);
    return {
        providers,
        getProvider: name => providers.get(name),
        DEFAULT_MODELS: Object.fromEntries([...providers].map(([n, p]) => [n, p.defaultModel])),
        supportsStructured: () => false,
    };
});

const { providers } = require('../src/services/ai/providers');
const { recordUsage } = require('../src/services/ai/usage');
const { resolveProviderConfig, getCompletion, streamCompletion, shouldFallBack } = require('../src/services/ai');

const openai = providers.get('openai');
const gemini = providers.get('gemini');

const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

function config(fallbacks = [{ provider: 'gemini', model: 'gemini-2.5-flash' }]) {
    return resolveProviderConfig({ provider: 'openai', model: 'gpt-x', fallbacks }, { guildId: 'g1' });
}

async function drain(stream) {
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const provider of providers.values()) {
        provider.complete.mockImplementation(async () => ({ text: `${provider.name} answered`, usage: { input: 1, output: 1 } }));
        provider.stream.mockImplementation(async function* () { yield `${provider.name} `; yield 'streamed'; });
    }
});
afterEach(() => jest.restoreAllMocks());

describe('which backups a guild gets', () => {
    test('each listed provider with a key, in order, with its own key and model', () => {
        expect(config().fallbacks).toEqual([{ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'gemini-key', baseUrl: null }]);
    });

    test('a backup with no key is left out rather than tried and failed', () => {
        expect(config([{ provider: 'anthropic' }]).fallbacks).toEqual([]);
    });

    test('a guild on its own key cannot spill onto the operator\'s env key through a backup', () => {
        expect(config([{ provider: 'openrouter' }]).fallbacks).toEqual([]);
    });

    test('the primary itself is not a backup, and an empty model means the default', () => {
        expect(config([{ provider: 'openai', model: 'gpt-x' }, { provider: 'gemini' }]).fallbacks)
            .toEqual([expect.objectContaining({ provider: 'gemini', model: 'gemini-default' })]);
    });

    test('at most two', () => {
        const three = [{ provider: 'gemini' }, { provider: 'gemini', model: 'b' }, { provider: 'gemini', model: 'c' }];
        expect(config(three).fallbacks).toHaveLength(2);
    });
});

describe('getCompletion', () => {
    test('answers with the primary when it works', async () => {
        await expect(getCompletion({ ...config(), prompt: 'hi', guildId: 'g1' })).resolves.toBe('openai answered');
        expect(gemini.complete).not.toHaveBeenCalled();
    });

    test.each([503, 529, 429, 401, 500])('falls back on HTTP %i, and bills the provider that answered', async status => {
        openai.complete.mockRejectedValueOnce(httpError(status));
        await expect(getCompletion({ ...config(), prompt: 'hi', guildId: 'g1' })).resolves.toBe('gemini answered');

        const request = gemini.complete.mock.calls[0][0];
        expect(request).toMatchObject({ model: 'gemini-2.5-flash', apiKey: 'gemini-key', prompt: 'hi' });
        expect(request).not.toHaveProperty('fallbacks');
        expect(recordUsage).toHaveBeenCalledWith('g1', 'gemini', 'gemini-2.5-flash', expect.anything());
    });

    test('falls back when the connection itself fails', async () => {
        openai.complete.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
        await expect(getCompletion({ ...config(), prompt: 'hi' })).resolves.toBe('gemini answered');
    });

    test('does not fall back on a request that is wrong', async () => {
        openai.complete.mockRejectedValueOnce(httpError(400));
        await expect(getCompletion({ ...config(), prompt: 'hi' })).rejects.toThrow('HTTP 400');
        expect(gemini.complete).not.toHaveBeenCalled();
    });

    test('does not replay a turn that already ran a tool', async () => {
        openai.complete.mockImplementationOnce(async ({ onToolEvent }) => {
            onToolEvent({ type: 'start', tool: 'create_event' });
            throw httpError(503);
        });
        const events = [];
        await expect(getCompletion({ ...config(), prompt: 'hi', onToolEvent: e => events.push(e) })).rejects.toThrow('HTTP 503');
        expect(gemini.complete).not.toHaveBeenCalled();
        // The caller still saw the event.
        expect(events).toEqual([{ type: 'start', tool: 'create_event' }]);
    });

    test('the last provider\'s failure is the one the caller sees', async () => {
        openai.complete.mockRejectedValueOnce(httpError(503));
        gemini.complete.mockRejectedValueOnce(httpError(502));
        await expect(getCompletion({ ...config(), prompt: 'hi' })).rejects.toThrow('HTTP 502');
    });
});

describe('streamCompletion', () => {
    test('falls back when the primary fails before saying anything', async () => {
        // A stream that fails before its first chunk, the way a refused connection does.
        openai.stream.mockImplementationOnce(() => ({
            [Symbol.asyncIterator]: () => ({ next: async () => { throw httpError(529); } }),
        }));
        await expect(drain(streamCompletion({ ...config(), prompt: 'hi' }))).resolves.toBe('gemini streamed');
    });

    test('never once the reply has started', async () => {
        openai.stream.mockImplementationOnce(async function* () { yield 'half an '; throw httpError(503); });
        await expect(drain(streamCompletion({ ...config(), prompt: 'hi' }))).rejects.toThrow('HTTP 503');
        expect(gemini.stream).not.toHaveBeenCalled();
    });

    test('nor after a tool ran', async () => {
        openai.stream.mockImplementationOnce(({ onToolEvent }) => ({
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    onToolEvent({ type: 'start' });
                    throw httpError(503);
                },
            }),
        }));
        await expect(drain(streamCompletion({ ...config(), prompt: 'hi' }))).rejects.toThrow('HTTP 503');
        expect(gemini.stream).not.toHaveBeenCalled();
    });
});

test('the bot\'s own limits are never retried on another provider', () => {
    expect(shouldFallBack(Object.assign(new Error('limit'), { rateLimited: true }))).toBe(false);
    expect(shouldFallBack(httpError(404))).toBe(true);
    expect(shouldFallBack(httpError(422))).toBe(false);
});

describe('saving the list from the dashboard', () => {
    const { validateAiUpdate } = require('../src/dashboard/routes/api/settings');

    test('takes up to two known providers', () => {
        expect(validateAiUpdate({ 'ai.fallbacks': [] })).toBeNull();
        expect(validateAiUpdate({ 'ai.fallbacks': [{ provider: 'gemini', model: null }, { provider: 'ollama', model: 'llama3.2' }] })).toBeNull();
    });

    test.each([
        ['not a list', { provider: 'gemini' }],
        ['three entries', [{ provider: 'gemini' }, { provider: 'gemini' }, { provider: 'gemini' }]],
        ['an unknown provider', [{ provider: 'skynet' }]],
        ['a model that is not a name', [{ provider: 'gemini', model: 'x'.repeat(101) }]],
    ])('refuses %s', (_label, value) => {
        expect(validateAiUpdate({ 'ai.fallbacks': value })).toEqual(expect.any(String));
    });

    test('and a write to one entry rather than the whole list', () => {
        expect(validateAiUpdate({ 'ai.fallbacks.0.provider': 'gemini' })).toMatch(/whole list/);
    });
});
