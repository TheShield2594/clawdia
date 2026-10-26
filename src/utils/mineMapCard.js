'use strict';

/**
 * The mine map, drawn: the picture `/mine map` puts in its embed.
 *
 * Each depth has one hand-inked painting of its rock face
 * (src/assets/mine-map/<depth>.jpg, generated on Higgsfield in the house style
 * — see assets/mine-map/STYLE.md). The player's 10×10 dig site is drawn over
 * it: untouched rock is the painting itself, every cell they have dug is
 * carved out of it as one connected, ink-outlined tunnel, an ore vein holds a
 * glowing gem in the depth's colour, a cave-in is choked with rubble, and an
 * orange pin marks where the miner stands.
 *
 * It is the /explore map's sibling and shares its stickers, pin and palette
 * (utils/exploreMapCard.js `primitives`). The same card-family contract
 * holds: every number drawn is also in the embed text, callers give the file
 * alt text, and nothing is drawn as an emoji.
 *
 * Cost: each depth's painting is decoded once per process; a render is a few
 * dozen canvas draws and a JPEG encode, which runs off the main thread.
 *
 * @module utils/mineMapCard
 */

const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./exploreMapCard');
const { MAP_SIZE, MAP_CELL } = require('../data/mineData');

const {
    plain, roundRect, fitText, sticker, disc, rng, playerMarker,
    FONT, INK, CREAM, CREAM_SHADE, ORANGE, WARM,
} = primitives;

const CARD_W = 1200;
const CARD_H = 800;
const FILE_EXT = 'jpg';
const JPEG_QUALITY = 0.9;
const ART_DIR = path.join(__dirname, '..', 'assets', 'mine-map');
const FALLBACK_DEPTH = 'surface_quarry';

// The dig site: a 10×10 grid of square cells in the middle of the rock face,
// with the left and right thirds left for the stickers.
const CELL = 62;
const GRID = CELL * MAP_SIZE;
const GRID_X = (CARD_W - GRID) / 2;
const GRID_Y = 86;

/**
 * Per depth: the tunnel's two tones (wall and floor) and the colour of an ore
 * vein's gem, picked to sit on that depth's painting the way its emblem does.
 */
const DEPTH_STYLE = {
    surface_quarry: { tunnel: '#3a2f27', floor: '#5a4a3c', gem: '#f5b041' },
    coal_tunnels:   { tunnel: '#15110f', floor: '#2b2420', gem: '#d6e4f0' },
    iron_mines:     { tunnel: '#241a14', floor: '#3e2c22', gem: '#e74c3c' },
    crystal_caves:  { tunnel: '#0d1626', floor: '#1b2a44', gem: '#5dade2' },
    the_abyss:      { tunnel: '#110a17', floor: '#25172f', gem: '#f4d03f' },
};

// ─── Art (decoded once per depth) ────────────────────────────────────────────

const art = new Map();

/** The painting for a depth, decoded once and shared; an unknown depth gets the quarry's. */
function depthArt(depthId) {
    const id = DEPTH_STYLE[depthId] ? depthId : FALLBACK_DEPTH;
    if (!art.has(id)) {
        const loading = loadImage(path.join(ART_DIR, `${id}.jpg`)).catch(err => {
            art.delete(id);
            throw err;
        });
        art.set(id, loading);
    }
    return art.get(id);
}

// ─── The dig site ────────────────────────────────────────────────────────────

const cellX = c => GRID_X + c * CELL;
const cellY = r => GRID_Y + r * CELL;

/** The dig site's frame: a faint cell grid over the rock and an inked dashed boundary. */
function drawSite(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(20,17,13,0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 1; i < MAP_SIZE; i++) {
        ctx.moveTo(GRID_X + i * CELL, GRID_Y);
        ctx.lineTo(GRID_X + i * CELL, GRID_Y + GRID);
        ctx.moveTo(GRID_X, GRID_Y + i * CELL);
        ctx.lineTo(GRID_X + GRID, GRID_Y + i * CELL);
    }
    ctx.stroke();
    ctx.setLineDash([14, 9]);
    ctx.lineWidth = 4;
    ctx.strokeStyle = CREAM;
    ctx.strokeRect(GRID_X, GRID_Y, GRID, GRID);
    ctx.setLineDash([]);
    ctx.restore();
}

/**
 * Every excavated cell, carved out of the rock as one shape: each cell's
 * square is stroked in heavy ink first and then all of them are filled, so
 * neighbouring cells merge into a single tunnel with one outline round it.
 */
function carveTunnels(ctx, cells, style) {
    const grow = 4;                        // squares overlap, so corners join cleanly
    const open = new Set(cells.map(({ r, c }) => r * MAP_SIZE + c));
    // One path of every cell, for the clip: roundRect() starts a fresh path, so
    // the union is traced with rect() instead.
    const trace = () => {
        ctx.beginPath();
        for (const { r, c } of cells) ctx.rect(cellX(c) - grow, cellY(r) - grow, CELL + grow * 2, CELL + grow * 2);
    };
    const each = draw => {
        for (const { r, c } of cells) {
            roundRect(ctx, cellX(c) - grow, cellY(r) - grow, CELL + grow * 2, CELL + grow * 2, 12);
            draw();
        }
    };
    ctx.save();
    // Drop shadow, then the ink rim, then the hollow.
    ctx.translate(3, 5);
    each(() => { ctx.fillStyle = 'rgba(20,17,13,0.45)'; ctx.fill(); });
    ctx.translate(-3, -5);
    each(() => { ctx.lineWidth = 9; ctx.strokeStyle = INK; ctx.stroke(); });
    each(() => { ctx.fillStyle = style.tunnel; ctx.fill(); });
    // Two tones: a lit floor wherever a tunnel has rock beneath it.
    trace();
    ctx.clip();
    ctx.fillStyle = style.floor;
    for (const { r, c } of cells) {
        if (r + 1 < MAP_SIZE && open.has((r + 1) * MAP_SIZE + c)) continue;
        ctx.fillRect(cellX(c) - grow, cellY(r) + CELL * 0.7, CELL + grow * 2, CELL * 0.3 + grow);
    }
    ctx.restore();
}

/** A faceted gem with an ink outline and a soft glow: an ore vein. */
function gem(ctx, cx, cy, color) {
    ctx.save();
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, CELL * 0.55);
    glow.addColorStop(0, `${color}aa`);
    glow.addColorStop(1, `${color}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(cx - CELL / 2, cy - CELL / 2, CELL, CELL);

    const w = CELL * 0.26, h = CELL * 0.3;
    const outline = [
        [cx - w, cy - h * 0.35], [cx - w * 0.5, cy - h], [cx + w * 0.5, cy - h],
        [cx + w, cy - h * 0.35], [cx, cy + h],
    ];
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // The upper facet a shade lighter: two tones, no gloss.
    ctx.beginPath();
    ctx.moveTo(cx - w, cy - h * 0.35);
    ctx.lineTo(cx - w * 0.5, cy - h);
    ctx.lineTo(cx + w * 0.5, cy - h);
    ctx.lineTo(cx + w, cy - h * 0.35);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fill();
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - w, cy - h * 0.35);
    ctx.lineTo(cx + w, cy - h * 0.35);
    ctx.moveTo(cx - w * 0.5, cy - h);
    ctx.lineTo(cx, cy + h);
    ctx.lineTo(cx + w * 0.5, cy - h);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
}

/** A cave-in: a cell-sized square at (x0, y0), `size` across, choked with inked grey boulders. */
function rubble(ctx, x0, y0, size, seed) {
    const rand = rng(`cavein:${seed}`);
    const rocks = [
        [0.3, 0.68, 0.22], [0.68, 0.7, 0.2], [0.5, 0.42, 0.21], [0.22, 0.32, 0.13], [0.78, 0.34, 0.14],
    ];
    ctx.save();
    for (const [fx, fy, fr] of rocks) {
        const x = x0 + size * (fx + (rand() - 0.5) * 0.06), y = y0 + size * (fy + (rand() - 0.5) * 0.06);
        const rr = size * fr;
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
            const a = (i / 7) * Math.PI * 2;
            const k = rr * (0.8 + rand() * 0.3);
            ctx.lineTo(x + Math.cos(a) * k, y + Math.sin(a) * k * 0.85);
        }
        ctx.closePath();
        ctx.fillStyle = '#8d8a85';
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, size / 25);
        ctx.strokeStyle = INK;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x - rr * 0.2, y - rr * 0.25, rr * 0.35, Math.PI, Math.PI * 1.8);
        ctx.lineWidth = Math.max(1, size / 31);
        ctx.strokeStyle = '#b9b5ae';
        ctx.stroke();
    }
    ctx.restore();
}

// ─── Stickers ────────────────────────────────────────────────────────────────

/** A progress bar: cream track, coloured fill, ink outline. */
function bar(ctx, x, y, w, frac, fill) {
    roundRect(ctx, x, y, w, 12, 6);
    ctx.fillStyle = CREAM_SHADE;
    ctx.fill();
    if (frac > 0) {
        roundRect(ctx, x, y, Math.max(12, w * Math.min(1, frac)), 12, 6);
        ctx.fillStyle = fill;
        ctx.fill();
    }
    roundRect(ctx, x, y, w, 12, 6);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
}

/** The left sticker: whose mine, which depth, and what the dig site holds so far. */
function drawPanel(ctx, { username, depthName, counts, style }) {
    const x = 26, w = GRID_X - 26 - 22, y = GRID_Y;
    const h = 300;
    sticker(ctx, x, y, w, h, { radius: 14, line: 3.5 });
    roundRect(ctx, x + 14, y + 10, w - 28, 5, 2.5);
    ctx.fillStyle = ORANGE;
    ctx.fill();

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pad = x + 16, inner = w - 32;

    ctx.fillStyle = INK;
    ctx.font = `bold 22px ${FONT}`;
    // The name is fitted on its own so a long one loses its tail, not the "'S".
    const owner = username
        ? `${fitText(ctx, username.toUpperCase(), inner - ctx.measureText("'S").width)}'S`
        : 'THE';
    ctx.fillText(owner, pad, y + 40);
    ctx.fillText('MINE', pad, y + 66);
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillStyle = WARM;
    if (depthName) ctx.fillText(fitText(ctx, depthName, inner), pad, y + 92);

    ctx.fillStyle = INK;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText('DUG OUT', pad, y + 128);
    ctx.textAlign = 'right';
    ctx.fillText(`${counts.explored}/${counts.total}`, x + w - 16, y + 128);
    bar(ctx, pad, y + 142, inner, counts.explored / counts.total, ORANGE);

    const row = (label, value, draw, ry) => {
        draw(pad + 14, ry);
        ctx.textAlign = 'left';
        ctx.fillStyle = INK;
        ctx.font = `bold 16px ${FONT}`;
        ctx.fillText(label, pad + 38, ry + 1);
        ctx.textAlign = 'right';
        ctx.fillText(String(value), x + w - 16, ry + 1);
    };
    row('ore veins', counts.ore, (cx, cy) => {
        disc(ctx, cx, cy, 14, style.tunnel);
        gem(ctx, cx, cy + 1, style.gem);
    }, y + 196);
    row('cave-ins', counts.caveIn, (cx, cy) => {
        disc(ctx, cx, cy, 14, style.tunnel);
        rubble(ctx, cx - 13, cy - 14, 26, 'panel');
    }, y + 242);
    ctx.restore();
}

/** The right sticker: what each mark on the site means. */
function drawLegend(ctx, style) {
    const x = GRID_X + GRID + 22, w = CARD_W - x - 26, y = GRID_Y;
    const items = [
        ['dug tunnel', (cx, cy) => {
            roundRect(ctx, cx - 14, cy - 14, 28, 28, 7);
            ctx.fillStyle = style.tunnel;
            ctx.fill();
            ctx.lineWidth = 3;
            ctx.strokeStyle = INK;
            ctx.stroke();
        }],
        ['ore vein', (cx, cy) => {
            disc(ctx, cx, cy, 15, style.tunnel);
            gem(ctx, cx, cy + 1, style.gem);
        }],
        ['cave-in', (cx, cy) => {
            disc(ctx, cx, cy, 15, style.tunnel);
            rubble(ctx, cx - 14, cy - 15, 28, 'legend');
        }],
        ['you', (cx, cy) => {
            ctx.save();
            ctx.translate(cx, cy + 14);
            ctx.scale(0.55, 0.55);
            playerMarker(ctx, 0, 0);
            ctx.restore();
        }],
    ];
    let rowY = y + 56;
    const h = 46 + items.length * 50;
    sticker(ctx, x, y, w, h, { radius: 14, line: 3.5 });
    ctx.save();
    ctx.fillStyle = INK;
    ctx.font = `bold 16px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('LEGEND', x + 16, y + 24);
    for (const [label, draw] of items) {
        draw(x + 34, rowY);
        ctx.fillStyle = INK;
        ctx.font = `bold 16px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText(label, x + 62, rowY + 1);
        rowY += 50;
    }
    ctx.restore();
}

/** A heavy ink frame with a cream keyline, as on the explore map. */
function drawFrame(ctx) {
    ctx.save();
    ctx.lineWidth = 12;
    ctx.strokeStyle = INK;
    ctx.strokeRect(6, 6, CARD_W - 12, CARD_H - 12);
    ctx.lineWidth = 3;
    ctx.strokeStyle = CREAM;
    ctx.strokeRect(14, 14, CARD_W - 28, CARD_H - 28);
    ctx.restore();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Counts of each kind of cell on a dig site, for the panel, the embed and the alt text. */
function siteCounts(cells) {
    const grid = Array.isArray(cells) ? cells : [];
    const count = code => grid.filter(v => v === code).length;
    return {
        explored: grid.filter(v => v && v !== MAP_CELL.ROCK).length,
        ore: count(MAP_CELL.ORE),
        caveIn: count(MAP_CELL.CAVE_IN),
        total: MAP_SIZE * MAP_SIZE,
    };
}

/**
 * Draws the mine map.
 *
 * @param {object} o
 * @param {number[]} o.cells     the player's `mining.mineMap`: MAP_SIZE² cell codes
 * @param {number} [o.row]       the miner's row
 * @param {number} [o.col]       the miner's column
 * @param {string} [o.depthId]   `mining.activeDepth`
 * @param {string} [o.depthName] the depth's display name, if the table knows it
 * @param {string} [o.username]
 * @returns {Promise<Buffer>}    JPEG
 */
async function createMineMapCard({ cells, row, col, depthId, depthName, username }) {
    const style = DEPTH_STYLE[depthId] ?? DEPTH_STYLE[FALLBACK_DEPTH];
    const image = await depthArt(depthId);
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, CARD_W, CARD_H);

    const grid = Array.isArray(cells) ? cells : [];
    const dug = [];
    for (let r = 0; r < MAP_SIZE; r++) {
        for (let c = 0; c < MAP_SIZE; c++) {
            const v = grid[r * MAP_SIZE + c];
            if (v && v !== MAP_CELL.ROCK) dug.push({ r, c, v });
        }
    }

    drawSite(ctx);
    if (dug.length) carveTunnels(ctx, dug, style);
    for (const { r, c, v } of dug) {
        if (v === MAP_CELL.ORE) gem(ctx, cellX(c) + CELL / 2, cellY(r) + CELL / 2, style.gem);
        else if (v === MAP_CELL.CAVE_IN) rubble(ctx, cellX(c), cellY(r), CELL, `${r}:${c}`);
    }
    const inGrid = n => Number.isInteger(n) && n >= 0 && n < MAP_SIZE;
    if (inGrid(row) && inGrid(col)) {
        playerMarker(ctx, cellX(col) + CELL / 2, cellY(row) + CELL * 0.78);
    }

    drawFrame(ctx);
    drawPanel(ctx, { username: plain(username), depthName, counts: siteCounts(grid), style });
    drawLegend(ctx, style);

    return encodeCanvas(canvas, 'image/jpeg', { quality: JPEG_QUALITY });
}

/** "1 ore vein", "3 ore veins". */
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Alt text for the attachment. */
function mineMapAltText({ cells, depthName, username }) {
    const { explored, total, ore, caveIn } = siteCounts(cells);
    const who = plain(username) || 'a miner';
    const where = depthName ? ` in ${depthName}` : '';
    return `Mine map for ${who}${where}: ${explored} of ${total} cells dug, ${plural(ore, 'ore vein')}, ${plural(caveIn, 'cave-in')}.`;
}

module.exports = {
    createMineMapCard,
    mineMapAltText,
    siteCounts,
    plural,
    CARD_W,
    CARD_H,
    FILE_EXT,
    DEPTH_STYLE,
    ART_DIR,
};
