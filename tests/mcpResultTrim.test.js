'use strict';

/**
 * #838. Both of the toolkit's result caps used to be `text.slice(0, limit)`,
 * and the failure that causes is specific rather than cosmetic: a tool result
 * is usually JSON, so the cut lands inside a string or a nesting level, and
 * what reaches the model is a document it cannot parse whose last field is a
 * half-written value. In a one-shot answer that is lossy. In a multi-step
 * chain it poisons the round after it — the model reads `"path": "src/servi`
 * as a filename and calls the next tool with it, and the failure surfaces
 * three steps downstream as an error about a file that never existed.
 *
 * So these are mostly about what survives: whole records, valid JSON, the
 * scalars a next step needs, and the end of the output as well as its start.
 */

const { trimResult, headAndTail, MIN_STRUCTURED_LIMIT, SHORT_MARKER } = require('../src/services/ai/mcp/trim');

/** The JSON document out of a trimmed result, without the note after it. */
function documentOf(text) {
    const at = text.indexOf('\n[trimmed');
    return JSON.parse(at >= 0 ? text.slice(0, at) : text);
}

const rows = count => Array.from({ length: count }, (_, i) => ({
    id: i,
    path: `src/services/module_${i}.js`,
    summary: `the ${i}th thing this tool found, described at some length`,
}));

describe('a result that already fits', () => {
    test('is returned exactly as it was', () => {
        expect(trimResult('short', 100)).toBe('short');
    });

    test('at exactly the limit, too', () => {
        const text = 'x'.repeat(500);
        expect(trimResult(text, 500)).toBe(text);
    });

    test('and a non-string is left alone rather than coerced', () => {
        expect(trimResult(null, 10)).toBeNull();
        expect(trimResult(undefined, 10)).toBeUndefined();
    });
});

describe('a JSON array over the limit', () => {
    const text = JSON.stringify(rows(400));
    const trimmed = trimResult(text, 4000);

    test('comes back as valid JSON', () => {
        expect(Array.isArray(documentOf(trimmed))).toBe(true);
    });

    test('within the budget it was given', () => {
        expect(trimmed.length).toBeLessThanOrEqual(4000);
    });

    test('holding whole records, never a half-written one', () => {
        for (const row of documentOf(trimmed)) {
            expect(row).toMatchObject({
                id: expect.any(Number),
                path: expect.stringMatching(/^src\/services\/module_\d+\.js$/),
                summary: expect.stringContaining('described at some length'),
            });
        }
    });

    // The two ends say what the answer looks like and where it stops. A
    // head-only cut says only the first.
    test('keeps the first record and the last', () => {
        const kept = documentOf(trimmed);
        expect(kept[0].id).toBe(0);
        expect(kept[kept.length - 1].id).toBe(399);
    });

    test('and says how many of how many it is showing', () => {
        const kept = documentOf(trimmed).length;
        expect(kept).toBeGreaterThan(1);
        expect(kept).toBeLessThan(400);
        expect(trimmed).toContain(`${kept} of 400 items shown`);
    });

    // The note goes after the document rather than inside it: a marker pushed
    // into an array changes the type of its elements, which hands the model a
    // new bug to work around instead of a smaller answer.
    test('the note is outside the JSON, so nothing changes type', () => {
        expect(documentOf(trimmed).every(row => typeof row === 'object')).toBe(true);
        expect(trimmed.slice(trimmed.indexOf('\n[trimmed'))).toMatch(/^\n\[trimmed/);
    });

    test('a one-element array has no middle to drop, and falls back to text', () => {
        const one = JSON.stringify([{ blob: 'z'.repeat(5000) }]);
        const out = trimResult(one, 1000);
        expect(out.length).toBeLessThanOrEqual(1000);
        expect(out).toContain('omitted');
    });
});

describe('a JSON object wrapping a list', () => {
    const text = JSON.stringify({ total: 812, nextCursor: 'cursor-abc-123', items: rows(300) });
    const trimmed = trimResult(text, 4000);

    test('keeps the scalars a following call needs', () => {
        expect(documentOf(trimmed)).toMatchObject({ total: 812, nextCursor: 'cursor-abc-123' });
    });

    test('and shrinks the list instead', () => {
        const doc = documentOf(trimmed);
        expect(doc.items.length).toBeGreaterThan(1);
        expect(doc.items.length).toBeLessThan(300);
        expect(trimmed).toContain('items entries shown');
    });

    test('picking the longest array when there are several', () => {
        const two = JSON.stringify({ tags: ['a', 'b'], results: rows(300) });
        const doc = documentOf(trimResult(two, 4000));

        expect(doc.tags).toEqual(['a', 'b']);
        expect(doc.results.length).toBeLessThan(300);
    });

    // Nothing to drop whole: one enormous scalar. The text path takes over
    // rather than returning something that does not fit.
    test('an object with no list falls back to head and tail', () => {
        const blob = JSON.stringify({ log: 'q'.repeat(9000) });
        const out = trimResult(blob, 1200);

        expect(out.length).toBeLessThanOrEqual(1200);
        expect(out).toContain('omitted');
    });
});

describe('output with no structure to preserve', () => {
    const log = `${Array.from({ length: 600 }, (_, i) => `line ${i} of some build output`).join('\n')}\nERROR: the build failed`;
    const trimmed = trimResult(log, 1500);

    test('keeps the start', () => {
        expect(trimmed).toContain('line 0 of some build output');
    });

    // The end of a log is where the error is; a head-only cut reliably removes
    // the half that was worth reading.
    test('and the end, which is where the error is', () => {
        expect(trimmed).toContain('ERROR: the build failed');
    });

    test('with a seam between them, so the two halves do not read as one', () => {
        expect(trimmed).toMatch(/\[… \d+ characters omitted …\]/);
    });

    test('and stays inside the budget', () => {
        expect(trimmed.length).toBeLessThanOrEqual(1500);
    });

    test('cutting on line boundaries rather than mid-line', () => {
        const [head] = trimmed.split('\n[…');
        for (const line of head.split('\n')) {
            if (line) expect(line).toMatch(/^line \d+ of some build output$/);
        }
    });

    // One very long line has no boundary to snap to, and snapping anyway would
    // throw the whole allowance away.
    test('one enormous line is cut where it must be', () => {
        const out = headAndTail('z'.repeat(9000), 1000);
        expect(out.length).toBeLessThanOrEqual(1000);
        expect(out).toContain('omitted');
    });
});

describe('a budget too small to say anything with', () => {
    // The one thing that still has to survive is that something was dropped:
    // output the model thinks is whole gets summarised as though it were.
    test('below the structured floor it still says it was cut', () => {
        const out = trimResult(JSON.stringify(rows(50)), MIN_STRUCTURED_LIMIT - 1);

        expect(out).toHaveLength(MIN_STRUCTURED_LIMIT - 1);
        expect(out.endsWith(SHORT_MARKER)).toBe(true);
    });

    test('and so does a budget with no room for the long note', () => {
        const out = trimResult('z'.repeat(5000), 220);

        expect(out).toHaveLength(220);
        expect(out.endsWith(SHORT_MARKER)).toBe(true);
    });

    test('a budget smaller than the marker itself is simply a cut', () => {
        expect(trimResult('abcdefghijklmno', 4)).toBe('abcd');
    });

    test('and a zero or negative budget returns the text untouched', () => {
        expect(trimResult('abc', 0)).toBe('abc');
        expect(trimResult('abc', -5)).toBe('abc');
    });
});

describe('whatever the shape and whatever the budget', () => {
    // The property the callers depend on: the toolkit charges the turn's
    // output budget by the length of what comes back, so a trimmer that
    // overshoots its limit is one that overspends the budget.
    const shapes = [
        JSON.stringify(rows(200)),
        JSON.stringify({ total: 9, items: rows(90) }),
        JSON.stringify({ nested: { deep: rows(40) } }),
        Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'),
        'x'.repeat(20000),
        `\`\`\`\n${'diff --git a/x b/x\n'.repeat(500)}\`\`\``,
        '{"unterminated": "json',
        '[]',
        '{}',
    ];

    test.each([80, 199, 200, 400, 1000, 6000])('never exceeds a %i-character budget', limit => {
        for (const shape of shapes) {
            expect(trimResult(shape, limit).length).toBeLessThanOrEqual(limit);
        }
    });

    test('and always says something was dropped when something was', () => {
        for (const shape of shapes) {
            for (const limit of [40, 250, 1000]) {
                const out = trimResult(shape, limit);
                if (out !== shape && limit > SHORT_MARKER.length) {
                    expect(out).toMatch(/omitted|trimmed|shown|cut…/);
                }
            }
        }
    });
});
