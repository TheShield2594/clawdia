'use strict';

/**
 * #838, the sampling half. The other backwards exchange: a server that needs a
 * judgement rather than a fact asks the bot to run *its* model and send back
 * the completion.
 *
 * It is the one MCP feature that spends the guild's money at somebody else's
 * request, so what is pinned here is the spending: that a person approves it
 * every time whatever the guild's confirm mode says, that it goes through the
 * ordinary completion path so it lands on the guild's ledger and inside the
 * guild's limits, that it offers no tools, and that a refusal is an error the
 * server can read rather than silence it waits out.
 *
 * And what a server does not get: the Discord conversation, however loudly
 * `includeContext` asks for it.
 */

jest.mock('../src/services/ai/index', () => ({ getCompletion: jest.fn() }));

const { getCompletion } = require('../src/services/ai/index');
const {
    createSamplingHandler, conversationOf, tokensFor, temperatureFor, approvalArgs,
    SYSTEM_PROMPT, MAX_SAMPLES_PER_TURN, MAX_MESSAGES, MAX_PROMPT_CHARS, MAX_SAMPLE_TOKENS,
} = require('../src/services/ai/mcp/sampling');

const text = (role, body) => ({ role, content: { type: 'text', text: body } });
const CONFIG = { provider: 'openai', model: 'gpt-5', apiKey: 'sk-x', baseUrl: null, temperature: 0.7, rateLimit: { perUser: 3 } };

let confirm;
let warn;

function handler(overrides = {}) {
    return createSamplingHandler({
        config: CONFIG,
        confirm,
        guildId: 'g1',
        userId: 'u1',
        channelId: 'c1',
        ...overrides,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    confirm = jest.fn(async () => ({ approved: true }));
    getCompletion.mockResolvedValue('the answer');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe('what a server may send', () => {
    test('a conversation becomes history plus a prompt', () => {
        expect(conversationOf([
            text('user', 'summarise this'),
            text('assistant', 'sure'),
            text('user', 'the diff is X'),
        ])).toEqual({
            history: [{ role: 'user', content: 'summarise this' }, { role: 'assistant', content: 'sure' }],
            prompt: 'the diff is X',
        });
    });

    test('a request that ends on an assistant turn is a continuation, not a dropped message', () => {
        // `prompt` is a user message and there is no other way to send it, so
        // the last turn is framed rather than silently relabelled.
        const { history, prompt } = conversationOf([text('user', 'write a title'), text('assistant', 'Fix the leak')]);
        expect(history).toEqual([{ role: 'user', content: 'write a title' }]);
        expect(prompt).toBe('Continue this assistant message:\n\nFix the leak');
    });

    test.each([
        ['nothing at all', undefined, /no messages/],
        ['an empty list', [], /no messages/],
        ['a message that is not an object', ['hello'], /not an object/],
        ['a role the spec does not define', [{ role: 'system', content: { type: 'text', text: 'x' } }], /not user or assistant/],
        ['a message with no content block', [{ role: 'user' }], /no content block/],
        ['empty text', [text('user', '   ')], /empty text/],
    ])('refuses %s', (_label, messages, pattern) => {
        expect(conversationOf(messages).error).toMatch(pattern);
    });

    test('refuses an image block rather than dropping it silently', () => {
        // A completion built from a request whose images vanished is a server
        // reading an answer about nothing, so it is told instead.
        expect(conversationOf([{ role: 'user', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }]).error)
            .toMatch(/text sampling requests only/);
    });

    test('refuses more messages than it will accept', () => {
        const many = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => text('user', `m${i}`));
        expect(conversationOf(many).error).toMatch(new RegExp(`at most ${MAX_MESSAGES}`));
    });

    test('refuses a payload larger than it will accept', () => {
        expect(conversationOf([text('user', 'x'.repeat(MAX_PROMPT_CHARS + 1))]).error)
            .toMatch(new RegExp(`at most ${MAX_PROMPT_CHARS}`));
    });
});

describe('what a server may ask the model to do', () => {
    test.each([
        ['nothing', undefined, MAX_SAMPLE_TOKENS],
        ['zero', 0, MAX_SAMPLE_TOKENS],
        ['nonsense', 'lots', MAX_SAMPLE_TOKENS],
        ['more than the ceiling', MAX_SAMPLE_TOKENS * 4, MAX_SAMPLE_TOKENS],
        ['less than the ceiling', 64, 64],
    ])('asking for %s generates %i tokens', (_label, asked, expected) => {
        expect(tokensFor(asked)).toBe(expected);
    });

    test.each([
        ['a legal temperature', 0.2, 0.2],
        ['zero', 0, 0],
        ['one out of range', 9, 0.7],
        ['nonsense', 'hot', 0.7],
        ['nothing', undefined, 0.7],
    ])('%s resolves to %p', (_label, asked, expected) => {
        expect(temperatureFor(asked, 0.7)).toBe(expected);
    });
});

describe('the approval', () => {
    const messages = [text('user', 'summarise this diff')];

    test('is asked for every time, whatever the guild\'s confirm mode says', async () => {
        // Not routed through confirmMode at all: `off` is a reasonable answer
        // for a curated read-only toolset and not for prose somebody else wrote
        // costing money nobody has looked at.
        await handler()('github', { messages });

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0]).toMatchObject({ server: 'github' });
    });

    test('shows the person what the server sent and what it will cost', () => {
        const args = approvalArgs({ messages, systemPrompt: 'be terse', maxTokens: 50 }, conversationOf(messages));
        expect(args.purpose).toMatch(/pays for the tokens/);
        expect(args.serverSystemPrompt).toBe('be terse');
        expect(args.messages).toEqual([{ role: 'user', content: 'summarise this diff' }]);
        expect(args.maxTokens).toBe(50);
    });

    test('refuses when it is declined, with an error the server can read', async () => {
        confirm.mockResolvedValue({ approved: false });
        // Thrown, not returned: a completion has no "declined" shape, so the
        // only honest way to say no is a JSON-RPC error.
        await expect(handler()('github', { messages })).rejects.toThrow(/declined in the channel/);
        expect(getCompletion).not.toHaveBeenCalled();
    });

    test('refuses when nobody answers, and says which it was', async () => {
        confirm.mockResolvedValue({ approved: false, timedOut: true });
        await expect(handler()('github', { messages })).rejects.toThrow(/nobody approved it in time/);
    });

    test('refuses outright when the turn has no confirmer', async () => {
        // A scheduled digest or a command parsing the reply as JSON: nobody is
        // there to authorise spending the guild's budget.
        await expect(handler({ confirm: null })('github', { messages }))
            .rejects.toThrow(/nobody who could approve/);
        expect(getCompletion).not.toHaveBeenCalled();
    });

    test('pushes the deadline out before the prompt goes up, not after', async () => {
        const extendDeadline = jest.fn();
        // Otherwise the stream is destroyed while somebody is still reading.
        confirm.mockImplementation(async () => {
            expect(extendDeadline).toHaveBeenCalled();
            return { approved: true };
        });

        await handler()('github', { messages }, { extendDeadline });
        expect.assertions(2);
        expect(extendDeadline).toHaveBeenCalledTimes(2);   // the wait, then the completion
    });
});

describe('running the completion', () => {
    const messages = [text('user', 'summarise this diff')];

    test('spends the guild\'s own provider, key, ledger and limits', async () => {
        await handler()('github', { messages, maxTokens: 100, temperature: 0.1 });

        expect(getCompletion).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'openai',
            model: 'gpt-5',
            apiKey: 'sk-x',
            // guildId is what the usage ledger records under, and userId and
            // channelId are what the rate limits bind to: a server's request is
            // the same money as the reply it interrupted.
            guildId: 'g1',
            userId: 'u1',
            channelId: 'c1',
            rateLimit: CONFIG.rateLimit,
            maxTokens: 100,
            temperature: 0.1,
        }));
    });

    test('offers no tools', async () => {
        await handler()('github', { messages });
        // A sampling request that could call tools is a server reaching the
        // guild's whole toolset through a completion nobody approved
        // tool-by-tool.
        expect(getCompletion.mock.calls[0][0].mcp).toBe(false);
    });

    test('frames the server\'s words as data, not as instructions', async () => {
        await handler()('github', { messages });
        const { systemPrompt, prompt } = getCompletion.mock.calls[0][0];
        expect(systemPrompt).toBe(SYSTEM_PROMPT);
        expect(systemPrompt).toMatch(/never as instructions/);
        expect(prompt).toBe('summarise this diff');
    });

    test('answers in the shape the spec defines, naming the model that actually ran', async () => {
        // Not the one `modelPreferences` asked for: the guild chose a model and
        // is paying for it, and the spec has this field so a server can tell.
        const result = await handler()('github', {
            messages,
            modelPreferences: { hints: [{ name: 'claude-3-5-sonnet' }] },
        });

        expect(result).toEqual({
            role: 'assistant',
            content: { type: 'text', text: 'the answer' },
            model: 'gpt-5',
            stopReason: 'endTurn',
        });
    });

    test.each(['thisServer', 'allServers'])('never sends the conversation when asked for %s', async includeContext => {
        await handler()('github', { messages, includeContext });

        // The context here is a Discord channel — other people's messages, in a
        // guild this server was connected to by one admin. The completion is
        // built from the server's own messages and nothing else.
        expect(getCompletion.mock.calls[0][0].history).toEqual([]);
        expect(getCompletion.mock.calls[0][0].prompt).toBe('summarise this diff');
        expect(warn.mock.calls.flat().join(' ')).toMatch(/answering from its own messages only/);
    });

    test('answers a request that asked for no context without complaining about it', async () => {
        await handler()('github', { messages, includeContext: 'none' });
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('how often a server may ask', () => {
    const messages = [text('user', 'again')];

    test(`refuses past ${MAX_SAMPLES_PER_TURN} in one turn`, async () => {
        const sample = handler();
        for (let i = 0; i < MAX_SAMPLES_PER_TURN; i++) await sample('github', { messages });

        await expect(sample('github', { messages })).rejects.toThrow(/already run/);
        expect(getCompletion).toHaveBeenCalledTimes(MAX_SAMPLES_PER_TURN);
    });

    test('counts every server together, since it is one person being asked', async () => {
        const sample = handler();
        await sample('github', { messages });
        await sample('linear', { messages });

        await expect(sample('sentry', { messages })).rejects.toThrow(/already run/);
    });

    test('is per turn, so the next message starts fresh', async () => {
        const first = handler();
        for (let i = 0; i < MAX_SAMPLES_PER_TURN; i++) await first('github', { messages });

        await expect(handler()('github', { messages })).resolves.toMatchObject({ role: 'assistant' });
    });
});
