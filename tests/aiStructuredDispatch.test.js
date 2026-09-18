'use strict';

// getStructuredCompletion's two branches (#1044). The dispatch chooses the
// provider-native structured path when the registry says the provider supports
// it, and the prompt-and-parse fallback (utils/modelJson) when it does not. The
// acceptance criteria for #1044 live here: the malformed-JSON retry is reachable
// ONLY on the fallback branch, and on a supporting provider a schema violation
// cannot arrive because the recovery that would paper over one is never run.

const mockStructured = jest.fn();
const mockComplete = jest.fn();
const mockSupportsStructured = jest.fn();
// Routed through a fn so a test can swap what a single call resolves to; the
// dispatch destructures `getProvider` at import, so the delegating arrow is what
// keeps the swap visible to it.
const mockGetProvider = jest.fn(() => ({ structured: mockStructured, complete: mockComplete }));

jest.mock('../src/services/ai/providers', () => ({
    providers: new Map(),
    getProvider: (...args) => mockGetProvider(...args),
    DEFAULT_MODELS: { mock: 'mock-1' },
    supportsStructured: (...args) => mockSupportsStructured(...args)
}));

// Limits and the ledger are exercised by their own suites; here they are no-ops
// so the dispatch's branch choice is what the tests see.
const mockEnforce = jest.fn();
jest.mock('../src/services/ai/rateLimit', () => ({
    enforceRateLimit: (...args) => mockEnforce(...args),
    toolCallBudget: jest.fn(() => ({}))
}));
const mockRecordUsage = jest.fn(async () => {});
jest.mock('../src/services/ai/usage', () => ({ recordUsage: (...args) => mockRecordUsage(...args) }));

const { getStructuredCompletion } = require('../src/services/ai');
const { DEFAULT_TOKEN_BUDGETS } = require('../src/utils/modelJson');

const BASE = {
    provider: 'mock',
    model: 'mock-1',
    guildId: 'g1',
    userId: 'u1',
    channelId: 'c1',
    rateLimit: { perUser: 0 },
    systemPrompt: 's',
    history: [],
    prompt: 'p',
    temperature: 0.9,
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    schemaName: 'thing'
};

beforeEach(() => jest.clearAllMocks());

describe('a provider with native structured support', () => {
    test('answers from provider.structured and never touches the parse-recovery path', async () => {
        mockSupportsStructured.mockReturnValue(true);
        mockStructured.mockResolvedValue({ data: { name: 'Ember' }, usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 } });

        const out = await getStructuredCompletion(BASE);

        expect(out).toEqual({ name: 'Ember' });
        expect(mockStructured).toHaveBeenCalledTimes(1);
        // The fallback runs getCompletion → provider.complete; a schema violation
        // can only slip in through the fence/brace recovery that path feeds, and
        // it is never reached here.
        expect(mockComplete).not.toHaveBeenCalled();
        // Bounded like any other call, and recorded against the guild.
        expect(mockEnforce).toHaveBeenCalledTimes(1);
        expect(mockRecordUsage).toHaveBeenCalledWith('g1', 'mock', 'mock-1', expect.objectContaining({ inputTokens: 3 }));
    });

    test('passes the schema through and defaults the native budget to the largest fallback budget', async () => {
        mockSupportsStructured.mockReturnValue(true);
        mockStructured.mockResolvedValue({ data: { name: 'x' }, usage: null });

        await getStructuredCompletion(BASE);

        const arg = mockStructured.mock.calls[0][0];
        expect(arg.schema).toBe(BASE.schema);
        expect(arg.schemaName).toBe('thing');
        expect(arg.maxTokens).toBe(DEFAULT_TOKEN_BUDGETS[DEFAULT_TOKEN_BUDGETS.length - 1]);
    });
});

describe('a provider without native structured support', () => {
    test('falls back to prompt-and-parse, and the malformed-JSON retry runs there', async () => {
        mockSupportsStructured.mockReturnValue(false);
        // getCompletion returns provider.complete().text; first answer is cut off
        // mid-string, the second is whole — exactly the retry the budgets exist
        // for, and it is only reachable on this branch.
        mockComplete
            .mockResolvedValueOnce({ text: '{"name":"Emb', usage: null })
            .mockResolvedValueOnce({ text: '{"name":"Ember"}', usage: null });

        const out = await getStructuredCompletion(BASE);

        expect(out).toEqual({ name: 'Ember' });
        expect(mockStructured).not.toHaveBeenCalled();
        expect(mockComplete).toHaveBeenCalledTimes(2);
        // Tools are off on the fallback so their output cannot derail the format.
        expect(mockComplete.mock.calls[0][0]).toMatchObject({ useMcp: false });
    });

    test('a provider that has no structured method at all also falls back', async () => {
        // supportsStructured true but the method is missing — belt and braces:
        // the dispatch requires both before taking the native path.
        mockSupportsStructured.mockReturnValue(true);
        mockGetProvider.mockReturnValueOnce({ complete: mockComplete });
        mockComplete.mockResolvedValue({ text: '{"name":"Ember"}', usage: null });

        const out = await getStructuredCompletion(BASE);

        expect(out).toEqual({ name: 'Ember' });
        expect(mockStructured).not.toHaveBeenCalled();
        expect(mockComplete).toHaveBeenCalledTimes(1);
    });
});
