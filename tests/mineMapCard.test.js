'use strict';

// The mine map, drawn (utils/mineMapCard.js): that every depth's painting
// ships where the Docker image will carry it, that each depth and the awkward
// edges render a JPEG of the card's size, that the counts it draws are the
// ones the embed reports, and that the alt text says what the picture shows.

const fs = require('fs');
const path = require('path');
const { loadImage } = require('canvas');
const {
    createMineMapCard, mineMapAltText, siteCounts, CARD_W, CARD_H, DEPTH_STYLE, ART_DIR,
} = require('../src/utils/mineMapCard');
const { DEPTHS, MAP_SIZE, MAP_CELL } = require('../src/data/mineData');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

async function expectCard(buffer) {
    expect(buffer.subarray(0, 3)).toEqual(JPEG_MAGIC);
    const img = await loadImage(buffer);
    expect([img.width, img.height]).toEqual([CARD_W, CARD_H]);
}

/** A dig site with a short tunnel, one vein and one cave-in. */
function site() {
    const cells = Array(MAP_SIZE * MAP_SIZE).fill(MAP_CELL.ROCK);
    cells[55] = MAP_CELL.DUG;
    cells[56] = MAP_CELL.ORE;
    cells[46] = MAP_CELL.CAVE_IN;
    cells[57] = MAP_CELL.DUG;
    return cells;
}

describe('the painted depths', () => {
    test('every depth in the data has a style and a painting under src/ at the card\'s shape', async () => {
        expect(ART_DIR.split(path.sep)).toContain('src');
        for (const id of Object.keys(DEPTHS)) {
            expect([id, Boolean(DEPTH_STYLE[id])]).toEqual([id, true]);
            const file = path.join(ART_DIR, `${id}.jpg`);
            expect([id, fs.existsSync(file)]).toEqual([id, true]);
            const img = await loadImage(file);
            expect(img.width / img.height).toBeCloseTo(CARD_W / CARD_H, 2);
        }
    });
});

describe('createMineMapCard', () => {
    test('draws every depth', async () => {
        for (const [id, depth] of Object.entries(DEPTHS)) {
            await expectCard(await createMineMapCard({
                cells: site(), row: 5, col: 8, depthId: id, depthName: depth.name, username: 'munge',
            }));
        }
    });

    test('the awkward edges still draw: an untouched site, a fully dug one, an unknown depth, no name, no map', async () => {
        await expectCard(await createMineMapCard({ cells: Array(100).fill(0), row: 5, col: 5, depthId: 'surface_quarry' }));
        await expectCard(await createMineMapCard({ cells: Array(100).fill(MAP_CELL.ORE), row: 0, col: 9, depthId: 'the_abyss' }));
        await expectCard(await createMineMapCard({ cells: site(), row: 99, col: -1, depthId: 'the_mantle' }));
        await expectCard(await createMineMapCard({ cells: null, depthId: undefined, username: '🐸 a very long username that goes on and on' }));
    });

    test('draws identically twice — the rubble is seeded, not random', async () => {
        const opts = { cells: site(), row: 5, col: 8, depthId: 'coal_tunnels', depthName: 'Coal Tunnels', username: 'munge' };
        const a = await createMineMapCard(opts);
        const b = await createMineMapCard(opts);
        expect(a.equals(b)).toBe(true);
    });
});

describe('siteCounts and the alt text', () => {
    test('counts dug cells of every kind, and veins and cave-ins on their own', () => {
        expect(siteCounts(site())).toEqual({ explored: 4, ore: 1, caveIn: 1, total: 100 });
        expect(siteCounts(null)).toEqual({ explored: 0, ore: 0, caveIn: 0, total: 100 });
    });

    test('says whose mine, which depth and what it holds, keeping underscores in the name', () => {
        const alt = mineMapAltText({ cells: site(), depthName: 'Coal Tunnels', username: 'snake_case_user' });
        expect(alt).toBe('Mine map for snake_case_user in Coal Tunnels: 4 of 100 cells dug, 1 ore vein, 1 cave-in.');
        expect(mineMapAltText({ cells: [] })).toContain('Mine map for a miner:');
    });
});
