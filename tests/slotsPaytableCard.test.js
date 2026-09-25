'use strict';

/**
 * The slots paytable image (src/games/casino/slotsPaytableCard.js).
 *
 * The picture is checked where a test can check a picture: it renders, at the
 * size it was laid out for, once per process; the art it draws ships; and the
 * alt text carries every row, so nothing on the card is only in pixels.
 */

const fs = require('fs');
const path = require('path');
const { loadImage } = require('canvas');
const { paytableImage, paytableAltText } = require('../src/games/casino/slotsPaytableCard');
const { SYMBOLS, TRIPLE_WILD_MULT, TRIPLE_BOOST_MULT, JACKPOT_CAP_MULT } = require('../src/games/casino/slotsReels');

const ART = path.join(__dirname, '..', 'src', 'assets', 'slot-symbols');

describe('the paytable image', () => {
    it('renders a portrait PNG, narrower than the grind cards so it reads on a phone', async () => {
        const img = await loadImage(await paytableImage());
        expect(img.width).toBe(820);
        expect(img.height).toBeGreaterThan(img.width * 1.5);
    }, 20_000);

    it('is drawn with the Hunt / Fish cards’ primitives and a palette from their theme table', () => {
        const { THEMES, primitives } = require('../src/utils/grindProfileCard');
        expect(Object.keys(THEMES.slots).sort()).toEqual(Object.keys(THEMES.fish).sort());
        expect(Object.keys(primitives)).toEqual(expect.arrayContaining(['FONT', 'roundRect', 'fitText', 'paintBackground']));
        const source = fs.readFileSync(require.resolve('../src/games/casino/slotsPaytableCard.js'), 'utf8');
        expect(source).toContain('THEMES.slots');
        expect(source).toContain('primitives');
    });

    it('is drawn once and kept', async () => {
        expect(paytableImage()).toBe(paytableImage());
    });

    it('ships every symbol it draws, with the Twemoji attribution beside them', () => {
        const names = ['cherry', 'lemon', 'grape', 'bell', 'diamond', 'star', 'wild', 'boost', 'scatter', 'slots', 'fire', 'clover'];
        for (const name of names) expect(fs.existsSync(path.join(ART, `${name}.png`))).toBe(true);
        expect(fs.readFileSync(path.join(ART, 'ATTRIBUTION.md'), 'utf8')).toContain('CC-BY 4.0');
    });
});

describe('its alt text', () => {
    const alt = paytableAltText();

    it('names every row the card shows', () => {
        expect(alt).toContain(`Triple Wild ${TRIPLE_WILD_MULT}x`);
        expect(alt).toContain(`up to ${JACKPOT_CAP_MULT}x`);
        expect(alt).toContain(`Triple Boost ${TRIPLE_BOOST_MULT}x`);
        for (const s of SYMBOLS.filter(x => x.type === 'regular')) {
            expect(alt).toContain(`Three ${s.plural} ${s.three}x`);
            if (s.pair) expect(alt).toContain(`Pair of ${s.plural} ${s.pair}x`);
        }
    });

    it('fits Discord’s 1,024-character limit', () => {
        expect(alt.length).toBeLessThanOrEqual(1024);
    });
});

describe('symbol art cache', () => {
    test('a failed load is not cached, so the next call can succeed', async () => {
        // The module takes loadImage when it loads, so spy on a fresh copy of
        // canvas before loading a fresh copy of it.
        jest.resetModules();
        const canvas = require('canvas');
        const real = canvas.loadImage;
        const spy = jest.spyOn(canvas, 'loadImage').mockRejectedValueOnce(new Error('EIO'));
        const { symbolArt } = require('../src/games/casino/slotsPaytableCard');

        await expect(symbolArt('cherry')).rejects.toThrow('EIO');
        spy.mockImplementation(real);
        await expect(symbolArt('cherry')).resolves.toBeTruthy();
        spy.mockRestore();
    });
});
