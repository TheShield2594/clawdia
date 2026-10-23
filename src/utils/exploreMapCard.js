'use strict';

/**
 * The Explorer's Map, drawn: the picture `/explore map` puts in its embed.
 *
 * The world is one hand-inked painting (src/assets/explore-map/world.jpg,
 * generated on Higgsfield in the house icon style — see
 * assets/explore-map/STYLE.md). It is the same for every player. What changes
 * per player is drawn over it:
 *   - a region they have walked shows the painting as it is;
 *   - one whose route is open but that they have never entered is washed out
 *     to a pale sepia, the way an unvisited place looks on a map you were sold;
 *   - one still out of reach is hidden under an inked cloud bank;
 *   - a seasonal island they cannot see this season is painted over with sea.
 * Found landmarks and secrets are markers, landmarks still to find are "?"
 * markers, a pin marks where the player stands, and each region carries a
 * sticker label with its name and how much of it is charted.
 *
 * What is visible comes from exploreService.mapRegionStates, the same source
 * the text map reads, so the picture can never show a region the text hides.
 *
 * Cost. The painting and its sepia twin are decoded once per process
 * (buildWorld) and every render after that is a handful of canvas draws —
 * a few tens of milliseconds on the main thread — and a JPEG encode, which
 * runs off it (see utils/canvasEncode.js).
 *
 * The card-family contract holds (see utils/petStatusCard.js): this is an
 * illustration, not the record. Every number drawn here is also in the embed
 * text, callers give the file alt text, and nothing is drawn as an emoji.
 * The overlay keeps to the brand palette in assets/icons/STYLE.md: ink,
 * cream and the warm orange accent, flat fills with a heavy ink outline.
 *
 * @module utils/exploreMapCard
 */

const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { ensureFontsRegistered } = require('./registerFonts');

ensureFontsRegistered();

const CARD_W = 1200;
const CARD_H = 800;
const FILE_EXT = 'jpg';
const JPEG_QUALITY = 0.9;
const WORLD_ART = path.join(__dirname, '..', 'assets', 'explore-map', 'world.jpg');

const FONT = '"DejaVu Sans"';
const INK = '#14110d';
const CREAM = '#faf6ef';
const CREAM_SHADE = '#e4dccb';
const ORANGE = '#f97316';
const WARM = '#d97742';
const GOLD = '#f1c40f';
const EDGE = 16;                 // lettering and stickers stay this far inside the frame

/**
 * Where each region sits on the painting, measured from the art: centre, a
 * radius, and how much flatter than a circle it is (`ry` = r × squash).
 */
const LAYOUT = {
    whispering_forest: { x: 358, y: 452, r: 125, squash: 0.92 },
    crumbling_ruins:   { x: 542, y: 232, r: 92,  squash: 0.85 },
    crystal_caves:     { x: 790, y: 172, r: 118, squash: 0.8 },
    sunken_docks:      { x: 868, y: 424, r: 100, squash: 0.82 },
    starfall_wastes:   { x: 610, y: 598, r: 150, squash: 0.82 },
    frostveil_pass:    { x: 148, y: 182, r: 112, squash: 0.85, island: true },
    arctic_tundra:     { x: 1050, y: 120, r: 92, squash: 0.8, island: true },
    velvet_arcade:     { x: 1095, y: 332, r: 82, squash: 1, island: true },
    scorchglass_shore: { x: 1075, y: 630, r: 92, squash: 0.85, island: true },
    hollowgrave_lane:  { x: 136, y: 640, r: 100, squash: 0.85, island: true },
};

// A region added to the data without a place on the painting still gets one:
// a spot of open sea, drawn as a small inked island of its own.
const SPARE_SLOTS = [
    { x: 330, y: 740, r: 40, squash: 0.8 },
    { x: 940, y: 740, r: 40, squash: 0.8 },
    { x: 420, y: 70, r: 40, squash: 0.8 },
];

// Open sea, sampled from the painting: what a hidden island is painted over with.
const SEA_SAMPLE = { x: 600, y: 760 };

// ─── Seeded randomness ───────────────────────────────────────────────────────

function hashSeed(str) {
    let h = 2166136261;
    for (const ch of String(str)) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function rng(seed) {
    let a = typeof seed === 'number' ? seed : hashSeed(seed);
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strips emoji, the joiners around them and Discord formatting, which a canvas cannot draw. */
function plain(str) {
    return String(str ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/[*_~`|]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Truncates `str` with an ellipsis to fit `max` in the current font. */
function fitText(ctx, str, max) {
    if (ctx.measureText(str).width <= max) return str;
    while (str.length > 1 && ctx.measureText(`${str}…`).width > max) str = str.slice(0, -1);
    return `${str.trimEnd()}…`;
}

const ry = place => place.r * (place.squash ?? 0.82);

/**
 * A flat sticker: cream fill, heavy ink outline and a hard offset shadow, the
 * way the brand mark and the item icons sit on their tiles.
 */
function sticker(ctx, x, y, w, h, { fill = CREAM, radius = 12, line = 3 } = {}) {
    roundRect(ctx, x + 3, y + 4, w, h, radius);
    ctx.fillStyle = 'rgba(20,17,13,0.45)';
    ctx.fill();
    roundRect(ctx, x, y, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = line;
    ctx.strokeStyle = INK;
    ctx.stroke();
}

// ─── The world (loaded once) ─────────────────────────────────────────────────

let worldPromise = null;

/**
 * Decodes the painting once and derives what the renders need from it: the
 * sepia wash for regions the player has not walked, and the sea colour that
 * paints over a hidden island. Idempotent; every call shares the first.
 *
 * @returns {Promise<object>}
 */
function buildWorld() {
    if (!worldPromise) {
        worldPromise = loadWorld().catch(err => {
            worldPromise = null;
            throw err;
        });
    }
    return worldPromise;
}

async function loadWorld() {
    const img = await loadImage(WORLD_ART);
    const art = createCanvas(CARD_W, CARD_H);
    const actx = art.getContext('2d');
    actx.drawImage(img, 0, 0, CARD_W, CARD_H);

    // Sepia: luminance laid over cream, with the ink kept dark so the drawing
    // still reads — a place you know of but have not seen.
    const data = actx.getImageData(0, 0, CARD_W, CARD_H);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
        const l = (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]) / 255;
        const t = 0.35 + 0.65 * l;
        px[i] = 236 * t; px[i + 1] = 222 * t; px[i + 2] = 190 * t;
    }
    const sepia = createCanvas(CARD_W, CARD_H);
    sepia.getContext('2d').putImageData(data, 0, 0);

    const s = actx.getImageData(SEA_SAMPLE.x, SEA_SAMPLE.y, 1, 1).data;
    return { art, sepia, sea: [s[0], s[1], s[2]] };
}

// ─── Region treatments ───────────────────────────────────────────────────────

/** Washes a region out to sepia, feathered at its edge. */
function washOut(ctx, place, sepia) {
    // Islands are painted whole inside their radius; reaching further would wash the sea.
    const reach = place.island ? 1.02 : 1.12;
    const rx = place.r * reach, rh = ry(place) * reach;
    const x0 = Math.max(0, Math.floor(place.x - rx)), y0 = Math.max(0, Math.floor(place.y - rh));
    const w = Math.min(CARD_W, Math.ceil(place.x + rx)) - x0, h = Math.min(CARD_H, Math.ceil(place.y + rh)) - y0;
    const patch = createCanvas(w, h);
    const p = patch.getContext('2d');
    p.drawImage(sepia, x0, y0, w, h, 0, 0, w, h);
    p.globalCompositeOperation = 'destination-in';
    p.translate(place.x - x0, place.y - y0);
    p.scale(1, rh / rx);
    const g = p.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.8, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    p.fillStyle = g;
    p.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.drawImage(patch, x0, y0);
}

/** Paints a hidden island out with open sea, feathered into the water around it. */
function seaOver(ctx, place, [r, g, b]) {
    const reach = place.r * 1.65;
    ctx.save();
    ctx.translate(place.x, place.y);
    ctx.scale(1, ry(place) / place.r);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.88, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
    ctx.restore();
}

/**
 * Terra incognita: a bank of cartoon clouds over the region — cream puffs,
 * shaded on their undersides, with one heavy ink outline round the whole bank.
 */
function cloudBank(ctx, place, seed) {
    const rand = rng(`${seed}:clouds`);
    const h = ry(place);
    const puffs = [];
    // Three rows of puffs, generous enough that no edge of the art peeks out.
    for (let row = 0; row < 3; row++) {
        const y = place.y - h * 0.62 + row * h * 0.62;
        const span = place.r * (row === 1 ? 1.0 : 0.78);
        const n = row === 1 ? 5 : 4;
        for (let i = 0; i < n; i++) {
            const x = place.x - span + (i / (n - 1)) * span * 2 + (rand() - 0.5) * place.r * 0.1;
            puffs.push([x, y + (rand() - 0.5) * h * 0.12, place.r * (0.36 + rand() * 0.08)]);
        }
    }
    const trace = (grow = 0, dx = 0, dy = 0) => {
        ctx.beginPath();
        for (const [x, y, r] of puffs) {
            ctx.moveTo(x + dx + r + grow, y + dy);
            ctx.arc(x + dx, y + dy, r + grow, 0, Math.PI * 2);
        }
    };
    ctx.save();
    trace(0, 4, 6);
    ctx.fillStyle = 'rgba(20,17,13,0.35)';
    ctx.fill();
    trace(3);
    ctx.fillStyle = INK;
    ctx.fill();
    trace();
    ctx.fillStyle = CREAM;
    ctx.fill();
    // Two tones per material: each puff's underside in the shade colour.
    ctx.clip();
    ctx.fillStyle = CREAM_SHADE;
    for (const [x, y, r] of puffs) {
        ctx.beginPath();
        ctx.arc(x + r * 0.2, y + r * 0.55, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

// ─── Markers ─────────────────────────────────────────────────────────────────

function disc(ctx, x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,17,13,0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
}

/** A found landmark: a cream pennant on an orange disc. */
function landmarkMarker(ctx, x, y) {
    disc(ctx, x, y, 13, ORANGE);
    ctx.save();
    ctx.fillStyle = CREAM;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    ctx.fillRect(x - 4.5, y - 7, 2.2, 14);
    ctx.beginPath();
    ctx.moveTo(x - 2.3, y - 7);
    ctx.lineTo(x + 7, y - 3.5);
    ctx.lineTo(x - 2.3, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/** A landmark still to find: a "?" on a cream disc. */
function unknownMarker(ctx, x, y) {
    disc(ctx, x, y, 11, CREAM);
    ctx.save();
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y + 1);
    ctx.restore();
}

function starPath(ctx, x, y, r, points = 5, inner = 0.45) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * inner;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
}

/** A found secret: a gold star with an ink outline. */
function secretMarker(ctx, x, y) {
    ctx.save();
    starPath(ctx, x + 2, y + 3, 13);
    ctx.fillStyle = 'rgba(20,17,13,0.45)';
    ctx.fill();
    starPath(ctx, x, y, 13);
    ctx.fillStyle = GOLD;
    ctx.fill();
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
}

/** The survey seal on a fully charted region's sticker: a gold rosette. */
function surveySeal(ctx, x, y, r) {
    ctx.save();
    starPath(ctx, x + 2, y + 3, r, 12, 0.8);
    ctx.fillStyle = 'rgba(20,17,13,0.45)';
    ctx.fill();
    starPath(ctx, x, y, r, 12, 0.8);
    ctx.fillStyle = GOLD;
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    starPath(ctx, x, y, r * 0.48, 5, 0.45);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
}

/** Where the player stands: an orange pin with an ink outline. */
function playerMarker(ctx, x, y) {
    const top = y - 50;
    const pin = (dx, dy) => {
        ctx.beginPath();
        ctx.moveTo(x + dx, y + dy);
        ctx.bezierCurveTo(x + dx - 7, y + dy - 16, x + dx - 18, y + dy - 26, x + dx - 18, top + dy + 18);
        ctx.arc(x + dx, top + dy + 18, 18, Math.PI, 0);
        ctx.bezierCurveTo(x + dx + 18, y + dy - 26, x + dx + 7, y + dy - 16, x + dx, y + dy);
        ctx.closePath();
    };
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y, 14, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,17,13,0.5)';
    ctx.fill();
    pin(3, 4);
    ctx.fillStyle = 'rgba(20,17,13,0.45)';
    ctx.fill();
    pin(0, 0);
    ctx.fillStyle = ORANGE;
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, top + 18, 7, 0, Math.PI * 2);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
}

/**
 * Marker spots in the top part of a region, clear of the sticker below it and
 * of the centre where the player's pin stands.
 */
function markerSpots(place, count, seed, from = 0.45, to = 0.8) {
    const rand = rng(seed);
    const spots = [];
    for (let i = 0; i < count; i++) {
        // Spread over the upper arc, from about eight o'clock round to four.
        const a = Math.PI * (0.85 + (count === 1 ? 0.65 : (i / (count - 1)) * 1.3)) + (rand() - 0.5) * 0.2;
        const d = from + rand() * (to - from);
        spots.push([place.x + Math.cos(a) * place.r * d, place.y + Math.sin(a) * ry(place) * d]);
    }
    return spots;
}

function drawMarkers(ctx, state, place) {
    const [found, total] = state.landmarks;
    const [secrets] = state.secrets;
    markerSpots(place, total, `${state.region.id}:marks`)
        .forEach(([x, y], i) => (i < found ? landmarkMarker(ctx, x, y) : unknownMarker(ctx, x, y)));
    markerSpots(place, secrets, `${state.region.id}:secrets`, 0.18, 0.38)
        .forEach(([x, y]) => secretMarker(ctx, x, y));
}

// ─── Stickers, roads and chrome ──────────────────────────────────────────────

/**
 * A region's sticker, low on the region: its name, and under it a progress
 * bar and figure, "unexplored", or — for a locked region on its cloud — the
 * level that opens it.
 */
function drawLabel(ctx, state, place) {
    const { region } = state;
    const compact = Boolean(place.island);
    const nameSize = compact ? 16 : 20;
    const subSize = compact ? 13 : 15;
    const locked = state.status === 'locked';
    const charted = state.status === 'charted';
    const name = locked ? 'UNCHARTED' : plain(region.name).toUpperCase();
    const cy = locked ? place.y : place.y + ry(place) * 0.6;

    let sub;
    if (locked) sub = `reach Explorer Lv ${region.unlockLevel}`;
    else if (state.status === 'known') sub = state.seasonal ? 'in season — unexplored' : 'unexplored';
    else {
        const note = state.seasonal && !state.inSeason ? ' · off season' : '';
        sub = state.surveyed ? `SURVEYED${note}` : `${state.pct}%${note}`;
    }

    ctx.save();
    ctx.font = `bold ${nameSize}px ${FONT}`;
    const nameText = fitText(ctx, name, compact ? 250 : 300);
    const nameW = ctx.measureText(nameText).width;
    ctx.font = `bold ${subSize}px ${FONT}`;
    const subText = fitText(ctx, sub, compact ? 200 : 260);
    const barW = compact ? 90 : 120;
    const subW = ctx.measureText(subText).width + (charted ? barW + 10 : 0);

    const w = Math.max(nameW, subW) + 24;
    const h = compact ? 50 : 58;
    const x = Math.max(EDGE, Math.min(place.x - w / 2, CARD_W - EDGE - w));
    const y = Math.max(EDGE, Math.min(cy - h / 2, CARD_H - EDGE - h));
    sticker(ctx, x, y, w, h, { fill: state.status === 'known' ? CREAM_SHADE : CREAM });

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = `bold ${nameSize}px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(nameText, x + w / 2, y + h * 0.33);

    const rowY = y + h * 0.72;
    ctx.font = `bold ${subSize}px ${FONT}`;
    if (!charted) {
        ctx.fillStyle = locked ? WARM : 'rgba(20,17,13,0.7)';
        ctx.fillText(subText, x + w / 2, rowY);
    } else {
        const rowX = x + w / 2 - subW / 2;
        roundRect(ctx, rowX, rowY - 5, barW, 10, 5);
        ctx.fillStyle = CREAM_SHADE;
        ctx.fill();
        if (state.pct > 0) {
            roundRect(ctx, rowX, rowY - 5, Math.max(10, (barW * state.pct) / 100), 10, 5);
            ctx.fillStyle = state.surveyed ? GOLD : ORANGE;
            ctx.fill();
        }
        roundRect(ctx, rowX, rowY - 5, barW, 10, 5);
        ctx.lineWidth = 2;
        ctx.strokeStyle = INK;
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillStyle = INK;
        ctx.fillText(subText, rowX + barW + 10, rowY + 1);
    }
    ctx.restore();

    if (state.surveyed) surveySeal(ctx, x + w - 4, y + 4, compact ? 13 : 16);
}

function drawRoads(ctx, legs) {
    for (const { from, to, walked } of legs) {
        const rand = rng(`${from.x},${from.y}:${to.x},${to.y}`);
        const mx = (from.x + to.x) / 2 + (rand() - 0.5) * 60;
        const my = (from.y + to.y) / 2 + (rand() - 0.5) * 60;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(mx, my, to.x, to.y);
        if (walked) {
            ctx.setLineDash([14, 10]);
            ctx.lineWidth = 9;
            ctx.strokeStyle = INK;
            ctx.stroke();
            ctx.lineWidth = 4.5;
            ctx.strokeStyle = CREAM;
            ctx.stroke();
        } else {
            ctx.setLineDash([1, 11]);
            ctx.lineWidth = 5;
            ctx.strokeStyle = 'rgba(20,17,13,0.65)';
            ctx.stroke();
        }
        ctx.restore();
    }
}

function drawTitle(ctx, username, level) {
    const title = "THE EXPLORER'S MAP";
    const who = username || 'an explorer';
    ctx.save();
    ctx.font = `bold 26px ${FONT}`;
    const tw = ctx.measureText(title).width;
    ctx.font = `bold 16px ${FONT}`;
    const sub = fitText(ctx, level ? `${who} · Explorer Lv ${level}` : who, 360);
    const sw = ctx.measureText(sub).width;
    const w = Math.max(tw, sw) + 40, h = 70;
    // Over open sea at the top, between the north-west isle and the crystal peaks.
    const x = CARD_W / 2 - w / 2 - 40, y = 18;
    sticker(ctx, x, y, w, h, { radius: 14, line: 3.5 });
    // The warm accent stroke from the brand mark, across the plate's top.
    roundRect(ctx, x + 14, y + 8, w - 28, 5, 2.5);
    ctx.fillStyle = ORANGE;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText(title, x + w / 2, y + 32);
    ctx.font = `bold 16px ${FONT}`;
    ctx.fillStyle = WARM;
    ctx.fillText(sub, x + w / 2, y + 55);
    ctx.restore();
}

function drawLegend(ctx) {
    const items = [
        [landmarkMarker, 'landmark'],
        [unknownMarker, 'to find'],
        [secretMarker, 'secret'],
        [(c, x, y) => surveySeal(c, x, y, 12), 'surveyed'],
    ];
    ctx.save();
    ctx.font = `bold 15px ${FONT}`;
    const widths = items.map(([, t]) => 30 + ctx.measureText(t).width);
    const w = widths.reduce((a, b) => a + b, 0) + 22 * (items.length - 1) + 32;
    const h = 40;
    const x = CARD_W / 2 - w / 2, y = CARD_H - EDGE - h - 6;
    sticker(ctx, x, y, w, h, { radius: 12 });
    let cx = x + 16;
    items.forEach(([draw, text], i) => {
        draw(ctx, cx + 11, y + h / 2);
        ctx.fillStyle = INK;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = `bold 15px ${FONT}`;
        ctx.fillText(text, cx + 30, y + h / 2 + 1);
        cx += widths[i] + 22;
    });
    ctx.restore();
}

/** A heavy ink frame with a cream keyline, like the brand plate. */
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

/** A region with no place on the painting gets a small inked island in open sea. */
function drawSpareIsland(ctx, place) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(place.x, place.y, place.r * 1.2, ry(place) * 1.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ecd9a6';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(place.x, place.y - 3, place.r * 0.9, ry(place) * 0.85, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#7fbf4d';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Gives every visible region a place: its own, or the next spare slot. */
function placeRegions(states) {
    let spare = 0;
    return states.map(state => {
        const own = LAYOUT[state.region.id];
        const place = own ?? { ...(SPARE_SLOTS[spare++ % SPARE_SLOTS.length]), island: true, spare: true };
        return { state, place };
    });
}

/**
 * Draws the map.
 *
 * @param {object} o
 * @param {Array} o.states     exploreService.mapRegionStates(user, guildSettings)
 * @param {string} [o.username]
 * @param {number} [o.level]   Explorer level, for the title
 * @returns {Promise<Buffer>}  JPEG
 */
async function createExploreMapCard({ states, username, level }) {
    const { art, sepia, sea } = await buildWorld();
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const placed = placeRegions(states ?? []);

    ctx.drawImage(art, 0, 0);

    // Seasonal islands the player cannot see this season go back to open sea.
    const shown = new Set(placed.map(p => p.state.region.id));
    for (const [id, place] of Object.entries(LAYOUT)) {
        if (place.island && !shown.has(id)) seaOver(ctx, place, sea);
    }
    for (const { state, place } of placed) {
        if (place.spare) drawSpareIsland(ctx, place);
        else if (state.status === 'known') washOut(ctx, place, sepia);
    }

    // The road runs through the core regions in the order their routes open;
    // a leg is walked once the player has set foot at both ends.
    const core = placed
        .filter(p => !p.state.seasonal && LAYOUT[p.state.region.id])
        .sort((a, b) => a.state.region.unlockLevel - b.state.region.unlockLevel);
    const legs = [];
    for (let i = 1; i < core.length; i++) {
        legs.push({
            from: core[i - 1].place,
            to: core[i].place,
            walked: core[i - 1].state.status === 'charted' && core[i].state.status === 'charted',
        });
    }
    drawRoads(ctx, legs);

    for (const { state, place } of placed) {
        if (state.status === 'locked') cloudBank(ctx, place, state.region.id);
    }
    for (const { state, place } of placed) {
        if (state.status === 'charted') drawMarkers(ctx, state, place);
    }
    const here = placed.find(p => p.state.active && p.state.status !== 'locked');
    if (here) playerMarker(ctx, here.place.x, here.place.y + 6);

    for (const { state, place } of placed) drawLabel(ctx, state, place);

    drawFrame(ctx);
    drawTitle(ctx, plain(username), level);
    drawLegend(ctx);

    return encodeCanvas(canvas, 'image/jpeg', { quality: JPEG_QUALITY });
}

/** Alt text for the attachment: the map as a screen reader would want it. */
function mapAltText(states, username) {
    const parts = (states ?? []).map(s => {
        if (s.status === 'locked') return `an uncharted region (Explorer Lv ${s.region.unlockLevel})`;
        if (s.status === 'known') return `${s.region.name} (unexplored)`;
        return `${s.region.name} ${s.pct}% charted`;
    });
    return `Explorer's map for ${plain(username) || 'an explorer'}: ${parts.join(', ')}.`;
}

module.exports = {
    createExploreMapCard,
    mapAltText,
    buildWorld,
    CARD_W,
    CARD_H,
    FILE_EXT,
    LAYOUT,
    WORLD_ART,
    __test__: { plain, placeRegions, hashSeed },
};
