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
    it('renders a 1600×1000 PNG', async () => {
        const buffer = await paytableImage();
        const img = await loadImage(buffer);
        expect([img.width, img.height]).toEqual([1600, 1000]);
    }, 20_000);

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
