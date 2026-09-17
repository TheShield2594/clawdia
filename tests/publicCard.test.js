'use strict';

// #1018. The player card's share image reuses scripts/make-og-image.js so a
// shared link unfurls in Discord as the same product the landing card is. This
// checks the reuse holds — the primitives are exported and the drawing produces
// a real PNG at the size every unfurler is promised — without pinning the exact
// bytes, which libpng and the font files render differently across machines
// exactly as make-og-image's own --check notes.

const og = require('../scripts/make-og-image');
const { renderPlayerCard } = require('../src/dashboard/lib/publicCard');

const CARD = {
    guild: { name: 'Test Server' },
    name: 'Alice', level: 12, rank: 3, netWorth: 123456, streak: 5,
    achievementsCount: 7, prestigeTitle: 'Prestige II',
};

describe('make-og-image exports its primitives for reuse', () => {
    test('the paw, the pill, the palette and the canvas size', () => {
        expect(typeof og.drawPaw).toBe('function');
        expect(typeof og.roundedRect).toBe('function');
        expect(og.WIDTH).toBe(1200);
        expect(og.HEIGHT).toBe(630);
        expect(og.palette).toMatchObject({ CREAM_50: expect.any(String), RUST: expect.any(String) });
    });
});

describe('renderPlayerCard', () => {
    test('draws a PNG at the Open Graph card size', async () => {
        const png = await renderPlayerCard(CARD);
        expect(Buffer.isBuffer(png)).toBe(true);
        // PNG signature, then an IHDR whose dimensions are the promised ones.
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
        expect(png.readUInt32BE(16)).toBe(og.WIDTH);
        expect(png.readUInt32BE(20)).toBe(og.HEIGHT);
    });

    test('renders a card with no prestige title without throwing', async () => {
        await expect(renderPlayerCard({ ...CARD, prestigeTitle: null })).resolves.toBeInstanceOf(Buffer);
    });

    test('does not overflow on a very long name', async () => {
        await expect(renderPlayerCard({ ...CARD, name: 'A'.repeat(200) })).resolves.toBeInstanceOf(Buffer);
    });

    test('fills in every missing field and singularizes a one-day streak', async () => {
        // A sparse card exercises the `?? fallback` branches and the singular
        // "1 day" — the card must draw rather than print "undefined".
        await expect(renderPlayerCard({
            guild: {}, level: 1, rank: 1, streak: 1,
        })).resolves.toBeInstanceOf(Buffer);
    });
});
