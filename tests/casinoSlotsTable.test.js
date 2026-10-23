'use strict';

/**
 * The slot machine image (#1199), drawn for real in every state the game shows:
 * spinning, the reveal with and without a tease, a result, a Hot Spin and the
 * free-spin strip. The game suite (casinoSlotsGame.test.js) checks which views
 * it asks for; this one checks each view draws.
 */

const { loadImage } = require('canvas');
const { renderMachine, W, H, __test__: { spinCache } } = require('../src/games/casino/slotsTable');

const base = { bet: 250, pot: 48_213, heat: 5, heatMax: 10 };
const SPIN = { cells: null };
const reel = (cells, extra = {}) => ({ cells, ...extra });

const STATES = {
    spinning: { ...base, reels: [SPIN, SPIN, SPIN], status: 'SPINNING…' },
    reel1:    { ...base, reels: [reel(['star', 'wild', 'grape']), SPIN, SPIN], status: 'SPINNING…' },
    tease:    {
        ...base,
        reels: [reel(['star', 'wild', 'grape']), reel(['diamond', 'wild', 'cherry']), { cells: null, glow: 'gold' }],
        tag: { text: 'ONE MORE WILD FOR THE JACKPOT', tone: 'gold' },
    },
    win: {
        ...base,
        reels: [reel(['star', 'wild', 'grape'], { hits: [1] }), reel(['bell', 'wild', 'cherry'], { hits: [1] }), reel(['lemon', 'diamond', 'bell'], { hits: [1] })],
        tag: { text: 'THREE DIAMONDS · 40×', tone: 'win' },
        banner: { text: 'MEGA WIN  +9,750', tone: 'gold' },
    },
    jackpot: {
        ...base,
        reels: [0, 1, 2].map(() => reel(['bell', 'wild', 'cherry'], { hits: [1], glow: 'gold' })),
        tag: { text: 'TRIPLE WILD · 100× + THE POT', tone: 'gold' },
        banner: { text: 'JACKPOT  +73,250', tone: 'gold' },
    },
    loss: {
        ...base,
        reels: [reel(['bell', 'cherry', 'star']), reel(['grape', 'lemon', 'cherry']), reel(['cherry', 'grape', 'diamond'])],
        tag: null,
        banner: { text: 'NO WIN', tone: 'lose' },
    },
    hot: {
        ...base, heat: 10, hot: true,
        reels: [reel(['grape', 'star', 'cherry'], { glow: 'hot' }), SPIN, SPIN],
        tag: { text: 'HOT SPIN · REEL 1 LOCKED', tone: 'hot' },
        status: 'SPINNING…',
    },
    scatters: {
        ...base,
        reels: [reel(['scatter', 'bell', 'grape'], { hits: [0, 1] }), reel(['cherry', 'bell', 'scatter'], { hits: [1, 2] }), reel(['grape', 'bell', 'lemon'], { hits: [1] })],
        tag: { text: 'THREE BELLS · 20×', tone: 'win' },
        banner: { text: 'FREE SPINS × 8', tone: 'gold' },
    },
    freeSpins: {
        ...base,
        free: [{ cells: ['star', 'star', 'star'], pay: 22_000 }, { cells: ['cherry', 'lemon', 'grape'], pay: 0 }, null, null, null, null, null, null],
        tag: { text: 'FREE SPIN 2 OF 8', tone: 'info' },
        banner: { text: 'FREE SPINS  +22,000', tone: 'gold' },
    },
    freeSpinsDone: {
        ...base, bet: 1_000_000_000, pot: 1_234_567,
        free: Array.from({ length: 15 }, (_, i) => ({ cells: ['diamond', 'diamond', 'wild'], pay: i % 4 ? 0 : 80_000_000_000 })),
        tag: { text: '4 OF 15 FREE SPINS HIT · +320,000,000,000', tone: 'win' },
        banner: { text: 'EPIC WIN  +319,000,000,000', tone: 'gold' },
    },
};

const isJpeg = buf => buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));

describe('renderMachine', () => {
    test.each(Object.keys(STATES))('draws the %s state as a small 960×560 JPEG', async name => {
        const jpg = await renderMachine(STATES[name]);
        expect(isJpeg(jpg)).toBe(true);
        // Several frames go up per spin; each has to stay small.
        expect(jpg.length).toBeLessThan(150_000);
        const image = await loadImage(jpg);
        expect([image.width, image.height]).toEqual([W, H]);
    }, 20_000);

    test('the spinning frame is drawn once and kept', async () => {
        spinCache.clear();
        const view = { ...base, bet: 777, reels: [SPIN, SPIN, SPIN], status: 'SPINNING…' };
        const first = await renderMachine(view);
        const again = await renderMachine({ ...view, reels: [SPIN, SPIN, SPIN] });
        expect(again).toBe(first);
        expect(spinCache.size).toBe(1);

        // Another stake is another frame; a frame with a stopped reel is never cached.
        expect(await renderMachine({ ...view, bet: 778 })).not.toBe(first);
        await renderMachine(STATES.reel1);
        expect(spinCache.size).toBe(2);
    }, 20_000);

    test('a spinning frame that fails to draw is not kept', async () => {
        spinCache.clear();
        // A bet the status pill cannot format breaks the draw.
        await expect(renderMachine({ ...base, bet: null, reels: [SPIN, SPIN, SPIN] })).rejects.toThrow();
        expect(spinCache.size).toBe(0);
    }, 20_000);
});
