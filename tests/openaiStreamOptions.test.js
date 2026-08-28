'use strict';

/**
 * #838. `stream_options: { include_usage: true }` is how a streamed OpenAI
 * response is made to report its token counts — without it the usage ledger has
 * nothing to charge and a guild's spend goes unmeasured — but it is an OpenAI
 * extension, and `baseURL` points this provider at anything that speaks the
 * chat-completions shape: llama.cpp, vLLM, LM Studio, a corporate gateway.
 * Several of those reject the unknown field with a 400 rather than ignoring it,
 * which turned "your usage numbers are missing" into "the bot cannot answer".
 *
 * So it is sent by default and withdrawn on evidence. These pin both halves:
 * that an endpoint which accepts it keeps its usage reporting, and that one
 * which refuses it gets an answer rather than an exception — and pays for the
 * discovery once rather than on every message.
 *
 * Each test builds the provider through `jest.isolateModules`, because the
 * set of refusing endpoints is process-lifetime state and a test that inherited
 * another's would be pinning the wrong thing.
 */

const mockCreate = jest.fn();
const mockConstructed = [];

jest.mock('openai', () =>
    jest.fn().mockImplementation(options => {
        mockConstructed.push(options);
        return { chat: { completions: { create: mockCreate } } };
    })
);

/** One streamed round that says "ok" and reports usage. */
function okStream() {
    return {
        async *[Symbol.asyncIterator]() {
            yield { choices: [{ delta: { content: 'ok' } }] };
            yield { usage: { prompt_tokens: 3, completion_tokens: 4 } };
        }
    };
}

/** The 400 an endpoint that has never heard of the parameter answers with. */
function rejection(message = 'Unrecognized request argument supplied: stream_options') {
    const err = new Error(message);
    err.status = 400;
    return err;
}

function loadProvider() {
    let provider;
    jest.isolateModules(() => { provider = require('../src/services/ai/providers/openai'); });
    return provider;
}

const REQ = {
    apiKey: 'k',
    model: 'gpt-4o',
    systemPrompt: 'be helpful',
    history: [],
    prompt: 'hi',
    maxTokens: 100,
    useMcp: false,
    mcpServers: []
};

async function collect(iterable) {
    const out = [];
    for await (const piece of iterable) out.push(piece);
    return out.join('');
}

let warn;

beforeEach(() => {
    jest.clearAllMocks();
    mockConstructed.length = 0;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe('an endpoint that accepts stream_options', () => {
    test('is asked for usage, and reports it', async () => {
        mockCreate.mockResolvedValue(okStream());
        const usageOut = {};

        const text = await collect(loadProvider().stream({ ...REQ, usageOut }));

        expect(text).toBe('ok');
        expect(mockCreate.mock.calls[0][0].stream_options).toEqual({ include_usage: true });
        expect(usageOut.usage).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    });

    test('is asked once per round, not retried', async () => {
        mockCreate.mockResolvedValue(okStream());

        await collect(loadProvider().stream(REQ));

        expect(mockCreate).toHaveBeenCalledTimes(1);
    });
});

describe('an endpoint that rejects it', () => {
    test('gets its answer from the retry without the parameter', async () => {
        mockCreate.mockRejectedValueOnce(rejection()).mockResolvedValue(okStream());

        const text = await collect(loadProvider().stream({ ...REQ, baseURL: 'http://llama.local/v1' }));

        expect(text).toBe('ok');
        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(mockCreate.mock.calls[1][0]).not.toHaveProperty('stream_options');
    });

    // The point of remembering: a guild on such an endpoint would otherwise pay
    // a failed request on every single message.
    test('is not asked again on the next message', async () => {
        mockCreate.mockRejectedValueOnce(rejection()).mockResolvedValue(okStream());
        const provider = loadProvider();
        const at = { ...REQ, baseURL: 'http://llama.local/v1' };

        await collect(provider.stream(at));
        mockCreate.mockClear();
        await collect(provider.stream(at));

        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('stream_options');
    });

    // Remembered per endpoint, so one gateway's refusal does not cost every
    // other guild in the process its usage accounting.
    test('does not speak for a different endpoint', async () => {
        mockCreate.mockRejectedValueOnce(rejection()).mockResolvedValue(okStream());
        const provider = loadProvider();

        await collect(provider.stream({ ...REQ, baseURL: 'http://llama.local/v1' }));
        mockCreate.mockClear();
        await collect(provider.stream(REQ));

        expect(mockCreate.mock.calls[0][0].stream_options).toEqual({ include_usage: true });
    });

    test('the error names the field, so the message is only a 400 away', async () => {
        mockCreate.mockRejectedValueOnce(rejection('include_usage is not supported')).mockResolvedValue(okStream());

        await collect(loadProvider().stream({ ...REQ, baseURL: 'http://vllm.local/v1' }));

        expect(mockCreate).toHaveBeenCalledTimes(2);
    });
});

describe('a 400 about anything else', () => {
    // Retrying these would double every genuine failure, and dropping usage
    // reporting would not fix one of them.
    test('is raised rather than retried', async () => {
        mockCreate.mockRejectedValue(rejection('model `gpt-9` does not exist'));

        await expect(collect(loadProvider().stream({ ...REQ, baseURL: 'http://gw.local/v1' })))
            .rejects.toThrow(/does not exist/);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    test('and leaves the endpoint asking for usage next time', async () => {
        mockCreate.mockRejectedValueOnce(rejection('bad model'));
        const provider = loadProvider();
        const at = { ...REQ, baseURL: 'http://gw.local/v1' };

        await expect(collect(provider.stream(at))).rejects.toThrow();
        mockCreate.mockResolvedValue(okStream());
        await collect(provider.stream(at));

        expect(mockCreate.mock.calls[1][0].stream_options).toEqual({ include_usage: true });
    });
});
