'use strict';

// #1049: OpenAI and Gemini pricing rows now carry a `cachedIn` rate, so the
// cached share of the input is billed at the provider's cache-read price rather
// than the full input rate. These exercise the *real* pricing tables (no mocked
// providers, unlike aiUsageCache.test.js) so a wrong or missing rate is caught,
// mirroring the Anthropic cache-read coverage the field was first added for.

const { estimateCost } = require('../src/services/ai/usage');

// Price the cached share at the full input rate — what estimateCost did before a
// row carried `cachedIn`, and still does for a row without one. A correct
// `cachedIn` must come in strictly under this.
function costAtFullInputRate(inRate, outRate, input, output) {
    return (input * inRate + output * outRate) / 1_000_000;
}

describe('OpenAI cached input pricing (#1049)', () => {
    // gpt-4o halves cached input: in 2.50 → cachedIn 1.25.
    test('gpt-4o bills cached input at 0.5x the input rate', () => {
        const cost = estimateCost('openai', 'gpt-4o', 1000, 100, 400);
        const expected = (600 * 2.50 + 400 * 1.25 + 100 * 10.00) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 12);
        expect(cost).toBeLessThan(costAtFullInputRate(2.50, 10.00, 1000, 100));
    });

    // The 4.1 line quarters it: in 2.00 → cachedIn 0.50.
    test('gpt-4.1 bills cached input at 0.25x the input rate', () => {
        const cost = estimateCost('openai', 'gpt-4.1', 1000, 100, 800);
        const expected = (200 * 2.00 + 800 * 0.50 + 100 * 8.00) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 12);
        expect(cost).toBeLessThan(costAtFullInputRate(2.00, 8.00, 1000, 100));
    });
});

describe('Gemini cached input pricing (#1049)', () => {
    // 2.0 Flash discounts a cache read to 0.25x: in 0.10 → cachedIn 0.025.
    test('gemini-2.0-flash bills cached input at the cache-read rate', () => {
        const cost = estimateCost('gemini', 'gemini-2.0-flash', 1000, 100, 400);
        const expected = (600 * 0.10 + 400 * 0.025 + 100 * 0.40) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 12);
        expect(cost).toBeLessThan(costAtFullInputRate(0.10, 0.40, 1000, 100));
    });

    // 1.5 Pro likewise: in 1.25 → cachedIn 0.3125.
    test('gemini-1.5-pro bills cached input at the cache-read rate', () => {
        const cost = estimateCost('gemini', 'gemini-1.5-pro', 1000, 100, 500);
        const expected = (500 * 1.25 + 500 * 0.3125 + 100 * 5.00) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 12);
        expect(cost).toBeLessThan(costAtFullInputRate(1.25, 5.00, 1000, 100));
    });

    // Flash-Lite supports no context caching, so it carries no `cachedIn` and any
    // cached count falls back to the full input rate — the unchanged, safe
    // (over-estimate) direction the cost ceiling prefers.
    test('gemini flash-lite falls back to the full input rate', () => {
        const cost = estimateCost('gemini', 'gemini-2.0-flash-lite', 1000, 100, 400);
        expect(cost).toBeCloseTo(costAtFullInputRate(0.075, 0.30, 1000, 100), 12);
    });
});

describe('Claude 5 pricing', () => {
    // Opus 5.5 and Sonnet 5.5 read cache at 0.05x input, the rest of the line at
    // 0.1x — so the 5.5 rows must win over the broader family rows below them.
    test.each([
        ['claude-opus-5-5',   4.00, 20.00, 0.20],
        ['claude-opus-5',     5.00, 25.00, 0.50],
        ['claude-opus-4-8',   5.00, 25.00, 0.50],
        ['claude-sonnet-5-5', 2.00, 10.00, 0.10],
        ['claude-sonnet-5',   2.00, 10.00, 0.20],
        ['claude-haiku-5-5',  0.10, 0.50,  0.01]
    ])('%s bills at its own rates', (model, inRate, outRate, cachedRate) => {
        const cost = estimateCost('anthropic', model, 1000, 100, 400);
        const expected = (600 * inRate + 400 * cachedRate + 100 * outRate) / 1_000_000;
        expect(cost).toBeCloseTo(expected, 12);
    });
});
