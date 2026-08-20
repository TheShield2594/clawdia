'use strict';

const { EMBED_LIMITS, packFields, fitDescription, chunkByLength, truncate } = require('../src/utils/embedFields');
const { RELIC_LIST } = require('../src/data/exploreData');

describe('truncate', () => {
    test('leaves short strings alone', () => {
        expect(truncate('short', 10)).toBe('short');
    });

    test('marks the cut and never exceeds the limit', () => {
        const out = truncate('x'.repeat(50), 10);
        expect(out).toHaveLength(10);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('packFields', () => {
    test('keeps a small list in a single field', () => {
        const fields = packFields('Items', ['one', 'two', 'three']);
        expect(fields).toHaveLength(1);
        expect(fields[0].name).toBe('Items');
        expect(fields[0].value).toBe('one\ntwo\nthree');
    });

    test('splits past the limit and marks continuations', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(60)}${i}`);
        const fields = packFields('Items', lines);
        expect(fields.length).toBeGreaterThan(1);
        expect(fields[0].name).toBe('Items');
        expect(fields[1].name).toBe('Items (cont.)');
        for (const field of fields) {
            expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.FIELD_VALUE);
        }
    });

    test('loses no lines while splitting', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(60)}${i}`);
        const rejoined = packFields('Items', lines).map(f => f.value).join('\n').split('\n');
        expect(rejoined).toEqual(lines);
    });

    test('truncates an oversized single line rather than dropping it', () => {
        const fields = packFields('Items', ['y'.repeat(5_000)]);
        expect(fields).toHaveLength(1);
        expect(fields[0].value.length).toBe(EMBED_LIMITS.FIELD_VALUE);
    });

    test('returns nothing for an empty list', () => {
        expect(packFields('Items', [])).toEqual([]);
    });
});

describe('fitDescription', () => {
    test('keeps everything when it fits', () => {
        const { text, omitted } = fitDescription(['a', 'b', 'c']);
        expect(text).toBe('a\nb\nc');
        expect(omitted).toBe(0);
    });

    test('drops whole trailing lines and counts them', () => {
        const lines = Array.from({ length: 10 }, () => 'z'.repeat(1_000));
        const { text, omitted } = fitDescription(lines);
        expect(text.length).toBeLessThanOrEqual(EMBED_LIMITS.DESCRIPTION);
        expect(omitted).toBeGreaterThan(0);
        // Never a half-rendered line: the kept text is a clean join
        expect(text.split('\n').every(l => l.length === 1_000)).toBe(true);
    });
});

describe('relic views stay inside Discord budgets', () => {
    const currency = '💰';

    test('a full relic collection fits the inventory field limit', () => {
        const lines = RELIC_LIST.map(r =>
            `${r.emoji} **${r.itemId}** *(${r.rarity} · ${r.regionName} · ${currency}${r.value.toLocaleString()})*`
        );
        const fields = packFields('🏺 Relics', lines);
        for (const field of fields) {
            expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.FIELD_VALUE);
        }
        // Nothing silently dropped — a collector sees every relic they own
        expect(fields.map(f => f.value).join('\n').split('\n')).toHaveLength(RELIC_LIST.length);
    });

    test('a full relic case fits the description limit once lore is dropped', () => {
        const render = withLore => RELIC_LIST.map(r => {
            const head = `${r.emoji} **${r.itemId}** — *${r.regionName}* · ${currency}${r.value.toLocaleString()}`;
            return withLore ? `${head}\n> *${r.lore}*` : head;
        });

        // With lore the full set genuinely overflows — that's why the fallback exists
        expect(render(true).join('\n').length).toBeGreaterThan(EMBED_LIMITS.DESCRIPTION);

        const { text, omitted } = fitDescription(render(false));
        expect(text.length).toBeLessThanOrEqual(EMBED_LIMITS.DESCRIPTION);
        expect(omitted).toBe(0);
    });
});

describe('chunkByLength', () => {
    test('keeps a list that fits in a single chunk', () => {
        expect(chunkByLength(['one', 'two'])).toEqual([['one', 'two']]);
    });

    test('gives nothing back for nothing', () => {
        expect(chunkByLength([])).toEqual([]);
    });

    test('every chunk joins to within the limit', () => {
        const lines  = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(180)}${i}`);
        const chunks = chunkByLength(lines, { separator: '\n\n' });

        for (const chunk of chunks) {
            expect(chunk.join('\n\n').length).toBeLessThanOrEqual(EMBED_LIMITS.DESCRIPTION);
        }
    });

    test('loses no line while chunking — the point of paging over trimming', () => {
        const lines = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(180)}${i}`);
        expect(chunkByLength(lines, { separator: '\n\n' }).flat()).toEqual(lines);
    });

    test('honours a per-chunk count as well as the character budget', () => {
        expect(chunkByLength(['a', 'b', 'c', 'd', 'e'], { maxPerChunk: 2 }))
            .toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    });

    test('truncates an oversized line into its own chunk rather than dropping it', () => {
        const chunks = chunkByLength(['short', 'y'.repeat(EMBED_LIMITS.DESCRIPTION + 500)]);

        expect(chunks).toHaveLength(2);
        expect(chunks[1][0]).toHaveLength(EMBED_LIMITS.DESCRIPTION);
        expect(chunks[1][0].endsWith('…')).toBe(true);
    });
});
