'use strict';

// The most delicate parsing in the tree, finally under test (#830).
//
// `/forge` and `/questgen` each had their own copy of "strip the fence, cut to
// the outermost braces, ask again with more tokens if it does not parse", and
// neither copy was covered by anything. These are the answers a model actually
// gives when it is asked for one JSON object.

const { extractJson, requestModelJson, DEFAULT_TOKEN_BUDGETS } = require('../src/utils/modelJson');

describe('extractJson', () => {
    test('takes a plain object as it stands', () => {
        expect(extractJson('{"name":"Ember Fang","target":12}'))
            .toEqual({ name: 'Ember Fang', target: 12 });
    });

    test('strips the markdown fence the prompt asked the model not to use', () => {
        expect(extractJson('```json\n{"name":"Ember Fang"}\n```')).toEqual({ name: 'Ember Fang' });
        expect(extractJson('```\n{"name":"Ember Fang"}\n```')).toEqual({ name: 'Ember Fang' });
    });

    // A truncated response loses the closing half of the fence as well as the
    // closing brace, so the two failures arrive together.
    test('survives a fence whose closing half never arrived', () => {
        expect(extractJson('```json\n{"name":"Ember Fang"}')).toEqual({ name: 'Ember Fang' });
    });

    test('isolates the object from prose either side of it', () => {
        const raw = 'Sure! Here is your item:\n{"name":"Ember Fang"}\nHope you like it.';
        expect(extractJson(raw)).toEqual({ name: 'Ember Fang' });
    });

    // The isolation cuts to the *outermost* braces, so an object with an object
    // inside it comes back whole rather than cut at the first nested close.
    test('keeps a nested object intact', () => {
        expect(extractJson('{"a":{"b":1},"c":2}')).toEqual({ a: { b: 1 }, c: 2 });
    });

    test('gives up on JSON cut off mid-string', () => {
        expect(extractJson('{"name":"Ember Fang","lore":"A blade forged in the')).toBeNull();
    });

    test('gives up on an answer with no JSON in it at all', () => {
        expect(extractJson('I cannot help with that request.')).toBeNull();
        expect(extractJson('')).toBeNull();
        expect(extractJson(null)).toBeNull();
        expect(extractJson(undefined)).toBeNull();
    });

    // Callers read properties off what comes back, so a bare scalar or an array
    // is as unusable as prose even though `JSON.parse` accepts both.
    test('refuses valid JSON that is not an object', () => {
        expect(extractJson('[1,2,3]')).toBeNull();
        expect(extractJson('42')).toBeNull();
        expect(extractJson('null')).toBeNull();
    });
});

describe('requestModelJson', () => {
    test('asks once when the first answer parses', async () => {
        const run = jest.fn(async () => '{"ok":true}');
        await expect(requestModelJson(run)).resolves.toEqual({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(DEFAULT_TOKEN_BUDGETS[0]);
    });

    // The retry the budgets exist for: a model that spends the first budget on
    // hidden reasoning hands back an object cut in half, and the same request
    // with room to finish is the only thing that fixes it.
    test('grows the budget when the answer was truncated', async () => {
        const run = jest.fn()
            .mockResolvedValueOnce('{"name":"Ember')
            .mockResolvedValueOnce('{"name":"Ember Fang"}');

        await expect(requestModelJson(run)).resolves.toEqual({ name: 'Ember Fang' });
        expect(run.mock.calls.map(call => call[0])).toEqual(DEFAULT_TOKEN_BUDGETS);
    });

    test('throws once every budget has been spent on prose', async () => {
        const run = jest.fn(async () => 'I cannot help with that request.');
        await expect(requestModelJson(run)).rejects.toMatchObject({ modelJson: true });
        expect(run).toHaveBeenCalledTimes(DEFAULT_TOKEN_BUDGETS.length);
    });

    test('says what the model actually sent, so a refusal is not logged as a parse error', async () => {
        const run = jest.fn(async () => 'I cannot help with that request.');
        await expect(requestModelJson(run)).rejects.toThrow(/I cannot help with that request/);
    });

    // A rate-limit refusal, a bad API key or a dropped connection would fail
    // the same way with more tokens, and the caller is holding a user's coins
    // waiting for the answer.
    test('lets a provider error out immediately rather than retrying it', async () => {
        const err = Object.assign(new Error('limit'), { rateLimited: true });
        const run = jest.fn(async () => { throw err; });

        await expect(requestModelJson(run)).rejects.toBe(err);
        expect(run).toHaveBeenCalledTimes(1);
    });

    test('takes the caller\'s own budgets', async () => {
        const run = jest.fn(async () => '{"ok":true}');
        await requestModelJson(run, { budgets: [128] });
        expect(run).toHaveBeenCalledWith(128);
    });
});
