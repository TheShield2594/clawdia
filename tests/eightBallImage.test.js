'use strict';

// The rendered ball. Everything here is geometry and cache behaviour — what the
// ball *looks* like isn't testable, but "the answer fits inside the die" is,
// and that is the property that breaks when an answer table changes.

const { renderEightBall, renderShakeClip, CLIP_FRAMES, __test__ } = require('../src/utils/eightBallImage');
const {
    stillCache, layoutAnswer, wrapInto, halfWidthAt, SIZE, SCENE_W, SCENE_H, CLIP_SCALE,
    TEXT_SIZES, FONT, APEX_Y, BASE_Y, HALF_BASE, WINDOW_R, CENTER, clearCaches,
} = __test__;
const { createCanvas } = require('canvas');
const { __test__: ball } = require('../src/commands/fun/8ball');
const { STRINGS } = ball;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const GIF_MAGIC = Buffer.from('GIF89a');
const ctx = () => createCanvas(SIZE, SIZE).getContext('2d');

// Every answer in every language, since each is drawn on the die.
const ALL_ANSWERS = Object.values(STRINGS).flatMap(s => Object.values(s.answers).flat());

beforeEach(() => clearCaches());

describe('renderEightBall', () => {
    test('renders a PNG scene of the expected size', () => {
        const png = renderEightBall('Yes.', 'positive');
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        // IHDR carries width and height as big-endian 32-bit ints at byte 16.
        expect(png.readUInt32BE(16)).toBe(SCENE_W);
        expect(png.readUInt32BE(20)).toBe(SCENE_H);
    });

    test('every answer in every language renders', () => {
        for (const text of ALL_ANSWERS) {
            const png = renderEightBall(text);
            expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
            expect(png.length).toBeGreaterThan(1000);
        }
        expect(stillCache.size).toBe(new Set(ALL_ANSWERS).size);
    });

    test('the die does not give the outlook away: only the words differ', () => {
        // Same words, any outlook → the same picture.
        expect(renderEightBall('Yes.', 'positive')).toBe(renderEightBall('Yes.', 'negative'));
        expect(renderEightBall('Yes.').equals(renderEightBall('No.'))).toBe(false);
    });

    test('repeat shakes of the same answer reuse the render', () => {
        const first  = renderEightBall('Signs point to yes.', 'positive');
        const second = renderEightBall('Signs point to yes.', 'positive');

        expect(second).toBe(first); // same buffer, not merely equal
        expect(stillCache.size).toBe(1);
    });
});

describe('renderShakeClip', () => {
    test('is a looping GIF with the still\'s aspect ratio, so the message never resizes', () => {
        const gif = renderShakeClip();
        expect(gif.subarray(0, 6)).toEqual(GIF_MAGIC);

        // Logical screen width and height, little-endian, straight after the magic.
        const w = gif.readUInt16LE(6);
        const h = gif.readUInt16LE(8);
        expect(w).toBe(Math.round(SCENE_W * CLIP_SCALE));
        expect(h).toBe(Math.round(SCENE_H * CLIP_SCALE));
        expect(w / h).toBeCloseTo(SCENE_W / SCENE_H, 2);

        // NETSCAPE2.0 loop extension: it repeats rather than stopping on a frame.
        expect(gif.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    });

    test('carries every frame', () => {
        const gif = renderShakeClip();
        // One graphic control extension (0x21 0xF9) per frame.
        let frames = 0;
        for (let i = 0; i < gif.length - 1; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9) frames++;
        expect(frames).toBe(CLIP_FRAMES);
    });

    test('stays a light upload', () => {
        expect(renderShakeClip().length).toBeLessThan(400_000);
    });

    test('is drawn once', () => {
        expect(renderShakeClip()).toBe(renderShakeClip());
    });
});

describe('geometry', () => {
    test('the die sits inside the window rather than poking past its rim', () => {
        const corners = [[CENTER, APEX_Y], [CENTER + HALF_BASE, BASE_Y], [CENTER - HALF_BASE, BASE_Y]];
        for (const [x, y] of corners) {
            expect(Math.hypot(x - CENTER, y - CENTER)).toBeLessThan(WINDOW_R);
        }
    });

    // Half-width shrinks to nothing at the apex, so a line placed high has less
    // room than one placed low. Text that ignored this would poke out the sides.
    test('the triangle narrows toward its apex', () => {
        const heights = [0.1, 0.25, 0.5, 0.75, 1].map(t => halfWidthAt(APEX_Y + t * (BASE_Y - APEX_Y)));
        for (let i = 1; i < heights.length; i++) {
            expect(heights[i]).toBeGreaterThan(heights[i - 1]);
        }
        expect(halfWidthAt(0)).toBe(0);
    });
});

describe('layoutAnswer', () => {
    test('every answer in every language fits within the die face at its chosen size', () => {
        const c = ctx();
        for (const text of ALL_ANSWERS) {
            const { lines, size, lineHeight, top } = layoutAnswer(c, text);
            c.font = `bold ${size}px ${FONT}`;

            expect(lines.join(' ')).toBe(text); // nothing dropped in the wrap
            expect(top).toBeGreaterThanOrEqual(APEX_Y);
            lines.forEach((line, i) => {
                const y = top + (i + 1) * lineHeight;
                expect(c.measureText(line).width).toBeLessThanOrEqual(halfWidthAt(y) * 2);
            });
        }
    });

    test('lands every answer on the size ladder, never the fallback', () => {
        const c = ctx();
        for (const text of ALL_ANSWERS) {
            const { size, lines } = layoutAnswer(c, text);
            expect(TEXT_SIZES).toContain(size);
            // The fallback is a single unwrapped line; a real fit of a multi-word
            // answer this long never is.
            if (text.length > 16) expect(lines.length).toBeGreaterThan(1);
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
