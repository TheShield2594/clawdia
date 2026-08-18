'use strict';

// The rendered ball. Everything here is geometry and cache behaviour — what the
// ball *looks* like isn't testable, but "the answer fits inside the die" is,
// and that is the property that breaks when the answer table changes.

const { renderEightBall, __test__ } = require('../src/utils/eightBallImage');
const { cache, layoutAnswer, wrapInto, halfWidthAt, SIZE, TINTS, FONT } = __test__;
const { createCanvas } = require('canvas');
const { __test__: ball } = require('../src/commands/fun/8ball');
const { RESPONSES } = ball;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ctx = () => createCanvas(SIZE, SIZE).getContext('2d');

beforeEach(() => cache.clear());

describe('renderEightBall', () => {
    test('renders a PNG of the expected size', () => {
        const png = renderEightBall('Yes.', 'positive');
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        // IHDR carries width and height as big-endian 32-bit ints at byte 16.
        expect(png.readUInt32BE(16)).toBe(SIZE);
        expect(png.readUInt32BE(20)).toBe(SIZE);
    });

    test('every answer in the table renders', () => {
        for (const [type, answers] of Object.entries(RESPONSES)) {
            for (const text of answers) {
                const png = renderEightBall(text, type);
                expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
                expect(png.length).toBeGreaterThan(1000);
            }
        }
        expect(cache.size).toBe(20);
    });

    test('each outlook is tinted differently, so the verdict reads before the text', () => {
        const [positive, neutral, negative] = ['positive', 'neutral', 'negative']
            .map(type => renderEightBall('Yes.', type));

        expect(positive.equals(neutral)).toBe(false);
        expect(neutral.equals(negative)).toBe(false);
        expect(positive.equals(negative)).toBe(false);
        expect(new Set(Object.values(TINTS).map(t => t.die)).size).toBe(3);
    });

    test('repeat shakes of the same answer reuse the render', () => {
        const first  = renderEightBall('Signs point to yes.', 'positive');
        const second = renderEightBall('Signs point to yes.', 'positive');

        expect(second).toBe(first); // same buffer, not merely equal
        expect(cache.size).toBe(1);
    });

    test('an unknown outlook still renders rather than throwing', () => {
        expect(renderEightBall('Who knows.', 'sideways').subarray(0, 4)).toEqual(PNG_MAGIC);
    });
});

describe('layoutAnswer', () => {
    // Half-width shrinks to nothing at the apex, so a line placed high has less
    // room than one placed low. Text that ignored this would poke out the sides.
    test('the triangle narrows toward its apex', () => {
        const heights = [0, 0.25, 0.5, 0.75, 1].map(t => halfWidthAt(160 + t * 150));
        for (let i = 1; i < heights.length; i++) {
            expect(heights[i]).toBeGreaterThan(heights[i - 1]);
        }
        expect(halfWidthAt(0)).toBe(0);
    });

    test('every answer fits within the die face at its chosen size', () => {
        const c = ctx();
        for (const text of Object.values(RESPONSES).flat()) {
            const { lines, size, lineHeight, top } = layoutAnswer(c, text);
            c.font = `bold ${size}px ${FONT}`;

            expect(lines.join(' ')).toBe(text); // nothing dropped in the wrap
            lines.forEach((line, i) => {
                const y = top + (i + 1) * lineHeight;
                expect(c.measureText(line).width).toBeLessThanOrEqual(halfWidthAt(y) * 2);
            });
        }
    });

    test('shorter answers get a larger font than longer ones', () => {
        const c = ctx();
        const short = layoutAnswer(c, 'Yes.');
        const long  = layoutAnswer(c, 'Concentrate and ask again.');
        expect(short.size).toBeGreaterThan(long.size);
    });

    test('falls back rather than throwing on text no size can fit', () => {
        const result = layoutAnswer(ctx(), 'Supercalifragilistic'.repeat(20));
        expect(result.lines.length).toBeGreaterThan(0);
        expect(result.size).toBeGreaterThan(0);
    });
});

describe('wrapInto', () => {
    test('fills each line up to its own width', () => {
        const c = ctx();
        c.font = `bold 20px ${FONT}`;
        expect(wrapInto(c, 'one two three', [1000])).toEqual(['one two three']);
    });

    test('refuses a wrap that would need more lines than it was given', () => {
        const c = ctx();
        c.font = `bold 20px ${FONT}`;
        expect(wrapInto(c, 'one two three four five', [40])).toBeNull();
    });

    test('refuses a single word too wide for its line', () => {
        const c = ctx();
        c.font = `bold 20px ${FONT}`;
        expect(wrapInto(c, 'unwrappable', [4])).toBeNull();
    });
});
