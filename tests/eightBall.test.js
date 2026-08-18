'use strict';

// The 8-ball's pure logic: the answer distribution the toy is supposed to have,
// and the question sanitising that keeps a hostile question inside its quote.

const { __test__ } = require('../src/commands/fun/8ball');
const { RESPONSES, TYPE_CONFIG, pickResponse, normalizeQuestion, quoteQuestion, MAX_QUESTION } = __test__;

// Deterministic stand-in for Math.random that walks a fixed list of values.
function seq(values) {
    let i = 0;
    return () => values[i++ % values.length];
}

describe('response table', () => {
    test('carries the classic 20 answers, 10/5/5', () => {
        expect(RESPONSES.positive).toHaveLength(10);
        expect(RESPONSES.neutral).toHaveLength(5);
        expect(RESPONSES.negative).toHaveLength(5);
    });

    test('every category has display config', () => {
        for (const type of Object.keys(RESPONSES)) {
            expect(TYPE_CONFIG[type]).toMatchObject({
                color:   expect.stringMatching(/^#[0-9a-f]{6}$/i),
                emoji:   expect.any(String),
                outlook: expect.any(String),
            });
        }
    });
});

describe('pickResponse', () => {
    test('maps the category roll to the documented 50/25/25 split', () => {
        expect(pickResponse(seq([0.00, 0])).type).toBe('positive');
        expect(pickResponse(seq([0.49, 0])).type).toBe('positive');
        expect(pickResponse(seq([0.50, 0])).type).toBe('neutral');
        expect(pickResponse(seq([0.74, 0])).type).toBe('neutral');
        expect(pickResponse(seq([0.75, 0])).type).toBe('negative');
        expect(pickResponse(seq([0.99, 0])).type).toBe('negative');
    });

    test('the second roll indexes within the category', () => {
        expect(pickResponse(seq([0.0, 0.0])).text).toBe(RESPONSES.positive[0]);
        expect(pickResponse(seq([0.0, 0.99])).text).toBe(RESPONSES.positive[9]);
        expect(pickResponse(seq([0.8, 0.99])).text).toBe(RESPONSES.negative[4]);
    });

    test('never indexes off the end of a pool', () => {
        for (const r of [0.0, 0.5, 0.75]) {
            const { type, text } = pickResponse(seq([r, 0.9999999]));
            expect(RESPONSES[type]).toContain(text);
        }
    });

    test('answers are uniform 1-in-20, like the physical toy', () => {
        // Sweep the category roll evenly, then the in-pool roll evenly: every
        // answer should come up the same number of times.
        const counts = new Map();
        const STEPS = 2000;
        for (let a = 0; a < STEPS; a++) {
            for (let b = 0; b < 20; b++) {
                const { text } = pickResponse(seq([a / STEPS, b / 20]));
                counts.set(text, (counts.get(text) ?? 0) + 1);
            }
        }

        const all = Object.values(RESPONSES).flat();
        expect(counts.size).toBe(20);
        expect(all.every(text => counts.has(text))).toBe(true);

        const expected = (STEPS * 20) / 20;
        for (const [, n] of counts) {
            // Well inside the rounding slack of the sweep.
            expect(Math.abs(n - expected)).toBeLessThan(expected * 0.02);
        }
    });

    test('defaults to Math.random and stays in the table', () => {
        for (let i = 0; i < 200; i++) {
            const { type, text } = pickResponse();
            expect(RESPONSES[type]).toContain(text);
        }
    });
});

describe('normalizeQuestion', () => {
    test('trims and collapses whitespace so the quote stays on one line', () => {
        expect(normalizeQuestion('  will   it\nrain\ttoday? ')).toBe('will it rain today?');
    });

    test('caps length even when the option limit is bypassed', () => {
        expect(normalizeQuestion('x'.repeat(500))).toHaveLength(MAX_QUESTION);
    });

    test('treats blank and missing input as no question', () => {
        expect(normalizeQuestion('   ')).toBe('');
        expect(normalizeQuestion('\n\t')).toBe('');
        expect(normalizeQuestion(null)).toBe('');
        expect(normalizeQuestion(undefined)).toBe('');
    });
});

describe('quoteQuestion', () => {
    test('escapes markdown instead of letting it reformat the embed', () => {
        const out = quoteQuestion('**bold** `code` ||spoiler||');
        expect(out).toContain('\\*\\*bold\\*\\*');
        expect(out).toContain('\\`code\\`');
        expect(out).not.toMatch(/(?<!\\)\|\|/);
    });

    test('renders as a single block-quote line', () => {
        const out = quoteQuestion(normalizeQuestion('am I\nsure?'));
        expect(out.split('\n')).toHaveLength(1);
        expect(out.startsWith('> ')).toBe(true);
    });
});
