'use strict';

/**
 * The Explorer's Map, drawn: the picture `/explore map` puts in its embed.
 *
 * An antique chart rather than a dashboard. The five core regions share one
 * continent, joined by the trail in the order their routes open; seasonal
 * regions are islands offshore. A region the player has walked is inked and
 * washed in its own colour, one they have opened but never entered is only
 * pencilled in, and one still out of reach sits under terra-incognita cloud.
 * Found landmarks are red pins, found secrets gold stars, a fully surveyed
 * region carries a wax seal, and a red cross marks where the player stands.
 *
 * What is visible comes from exploreService.mapRegionStates, the same source
 * the text map reads, so the picture can never show a region the text hides.
 *
 * Discord shrinks an embed image to roughly a third of its width on a phone,
 * so lettering here is sized for that, not for the full-size file.
 *
 * The card-family contract holds (see utils/petStatusCard.js): this is an
 * illustration, not the record. Every number drawn here is also in the embed
 * text, callers give the file alt text, and nothing is drawn as an emoji
 * (node-canvas draws colour emoji as boxes) — the terrain is canvas strokes.
 * Lettering is IM Fell English and Cinzel Decorative, bundled in src/fonts and
 * registered by utils/registerFonts.js, with DejaVu as the fallback face.
 *
 * Every wobble, tree and cloud comes from a PRNG seeded by what it decorates,
 * so a player's map draws identically every time it is unrolled.
 *
 * @module utils/exploreMapCard
 */

const { createCanvas } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { ensureFontsRegistered } = require('./registerFonts');

ensureFontsRegistered();

const CARD_W = 1200;
const CARD_H = 840;
const BORDER = 30;                 // parchment margin outside the neatline
const INNER = BORDER + 14;         // inside the scale-bar border

const SERIF = '"IM Fell English", "DejaVu Sans"';
const SERIF_SC = '"IM Fell English SC", "IM Fell English", "DejaVu Sans"';
const DISPLAY = '"Cinzel Decorative", "IM Fell English SC", "DejaVu Sans"';

const INK = '#2b1d10';
const INK_MID = 'rgba(43,29,16,0.62)';
const INK_SOFT = 'rgba(43,29,16,0.38)';
const PAPER = '#efe0bb';
const PAPER_LIGHT = '#f6ebcf';
const PAPER_DARK = '#d9bf8c';
const SEA = '#c9d2bd';
const SEA_DEEP = '#a9b9a6';
const SEAL_RED = '#8e1f1b';
const PIN_RED = '#b0302a';
const GOLD = '#c8961e';

/**
 * Where each region sits and what its land looks like. Core regions trace the
 * trail west to east in unlock order; seasonal ones are offshore islands.
 * `r` is the region's radius on the map.
 */
const LAYOUT = {
    whispering_forest: { x: 360, y: 510, r: 100, terrain: 'forest' },
    crumbling_ruins:   { x: 545, y: 272, r: 92,  terrain: 'ruins' },
    crystal_caves:     { x: 830, y: 195, r: 92,  terrain: 'mountains' },
    sunken_docks:      { x: 890, y: 450, r: 84,  terrain: 'harbour' },
    starfall_wastes:   { x: 650, y: 555, r: 100, terrain: 'wastes' },
    frostveil_pass:    { x: 135, y: 330, r: 56, terrain: 'mountains', island: true, snow: true },
    hollowgrave_lane:  { x: 118, y: 700, r: 50, terrain: 'forest', island: true, dark: true, label: 'right' },
    arctic_tundra:     { x: 1080, y: 150, r: 48, terrain: 'mountains', island: true, snow: true },
    velvet_arcade:     { x: 1100, y: 318, r: 44, terrain: 'hills', island: true },
    scorchglass_shore: { x: 1085, y: 680, r: 52, terrain: 'dunes', island: true },
};

// A region added to the data without a place here still gets one: the next
// free offshore slot, so a new seasonal region shows up before anyone draws it.
const SPARE_SLOTS = [
    { x: 330, y: 760, r: 40, label: 'right' },
    { x: 540, y: 110, r: 40, label: 'right' },
    { x: 125, y: 480, r: 40 },
];

// The coast of the continent, before roughening.
const CONTINENT = [
    [270, 400], [360, 330], [430, 250], [500, 185], [610, 150], [720, 100],
    [840, 88], [930, 125], [980, 215], [1000, 320], [1005, 420], [990, 520],
    [945, 600], [860, 650], [775, 705], [660, 728], [540, 715], [440, 690],
    [340, 672], [262, 632], [232, 545], [238, 465],
];

const COMPASS = { x: 1095, y: 505, r: 50 };

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

function rgba(hex, alpha) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return `rgba(43,29,16,${alpha})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Mixes a hex colour toward black (amount < 0) or white (amount > 0). */
function shade(hex, amount) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return hex;
    const ch = v => Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Strips emoji, the joiners around them and Discord formatting, which a canvas cannot draw. */
function plain(str) {
    return String(str ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/[*_~`|]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** A closed, hand-drawn looking outline around (cx, cy). */
function blobPoints(cx, cy, r, seed, n = 20, wobble = 0.22, squash = 0.8) {
    const rand = rng(seed);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (1 - wobble / 2 + rand() * wobble);
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * squash]);
    }
    return pts;
}

/** Traces a smooth closed curve through `pts`. */
function tracePath(ctx, pts) {
    ctx.beginPath();
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const start = mid(pts[pts.length - 1], pts[0]);
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const m = mid(p, pts[(i + 1) % pts.length]);
        ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]);
    }
    ctx.closePath();
}

/** Subdivides a coarse outline and jitters it, so coasts read as coastline. */
function roughen(pts, seed, jitter = 16, steps = 5) {
    const rand = rng(seed);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        for (let s = 0; s < steps; s++) {
            const t = s / steps;
            out.push([
                x1 + (x2 - x1) * t + (rand() - 0.5) * jitter,
                y1 + (y2 - y1) * t + (rand() - 0.5) * jitter,
            ]);
        }
    }
    return out;
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
function fitText(ctx, str, max, spacing = 0) {
    const width = s => ctx.measureText(s).width + spacing * Math.max(0, s.length - 1);
    if (width(str) <= max) return str;
    while (str.length > 1 && width(`${str}…`) > max) str = str.slice(0, -1);
    return `${str.trimEnd()}…`;
}

/**
 * Engraved lettering: optional letter-spacing, a paper halo so it reads over
 * terrain, centred on (x, y).
 */
function letter(ctx, str, x, y, {
    font, color = INK, spacing = 0, max = 400, halo = PAPER_LIGHT, haloWidth = 7, align = 'center',
} = {}) {
    ctx.save();
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const s = fitText(ctx, str, max, spacing);
    const chars = [...s];
    const widths = chars.map(c => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    // Keep lettering inside the neatline, whatever sits near the edge.
    const lo = INNER + 12, hi = CARD_W - INNER - 12;
    cx = Math.max(lo, Math.min(cx, hi - total));

    const paint = fn => {
        let px = cx;
        chars.forEach((c, i) => { fn(c, px); px += widths[i] + spacing; });
    };
    if (halo) {
        // A soft plate of clean paper behind the lettering, feathered by
        // stacking three translucent rounded rects. Cheaper by far than a
        // stroked halo: node-canvas strokes glyph outlines slowly, and a map
        // carries a lot of lettering.
        const size = Number(/(\d+)px/.exec(font)?.[1]) || 20;
        const pad = haloWidth * 0.6;
        for (const [grow, alpha] of [[pad + 8, 0.28], [pad + 4, 0.34], [pad, 0.5]]) {
            roundRect(ctx, cx - grow, y - size * 0.5 - grow * 0.55, total + grow * 2, size + grow * 1.1, size * 0.4 + grow * 0.5);
            ctx.fillStyle = rgba(halo, alpha);
            ctx.fill();
        }
    }
    ctx.fillStyle = color;
    paint((c, px) => ctx.fillText(c, px, y));
    ctx.restore();
    return { left: cx, right: cx + total };
}

/** Points on a jittered grid that fall inside `path` (a traced ctx path). */
function fillPoints(ctx, pts, spacing, seed, bounds) {
    const rand = rng(seed);
    const out = [];
    tracePath(ctx, pts);
    const [x0, y0, x1, y1] = bounds;
    for (let y = y0; y <= y1; y += spacing * 0.8) {
        for (let x = x0; x <= x1; x += spacing) {
            const px = x + (rand() - 0.5) * spacing * 0.9;
            const py = y + (rand() - 0.5) * spacing * 0.7;
            if (ctx.isPointInPath(px, py)) out.push([px, py, rand()]);
        }
    }
    return out.sort((a, b) => a[1] - b[1]);
}

// ─── Paper and sea ───────────────────────────────────────────────────────────

function paintSea(ctx) {
    const g = ctx.createRadialGradient(CARD_W * 0.5, CARD_H * 0.48, 120, CARD_W * 0.5, CARD_H * 0.5, CARD_W * 0.7);
    g.addColorStop(0, SEA);
    g.addColorStop(1, SEA_DEEP);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Rhumb lines: the web of bearings a chart radiates from its compass rose.
    ctx.save();
    ctx.strokeStyle = 'rgba(43,29,16,0.13)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(COMPASS.x, COMPASS.y);
        ctx.lineTo(COMPASS.x + Math.cos(a) * 2000, COMPASS.y + Math.sin(a) * 2000);
        ctx.stroke();
    }
    ctx.restore();

    // Scattered wave strokes out in open water.
    const rand = rng('sea');
    ctx.save();
    ctx.strokeStyle = 'rgba(43,29,16,0.28)';
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 90; i++) {
        const x = rand() * CARD_W, y = rand() * CARD_H, w = 8 + rand() * 10;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + w / 2, y - w * 0.45, x + w, y);
        ctx.quadraticCurveTo(x + w * 1.5, y - w * 0.45, x + w * 2, y);
        ctx.stroke();
    }
    ctx.restore();
}

/**
 * Land: coastline ripple lines out in the water, the paper fill, a shaded
 * inner coast and a heavy inked shoreline.
 */
function paintLand(ctx, pts) {
    ctx.save();
    // Ripples: widest first, each a faint ink ring left by a sea-coloured stroke.
    tracePath(ctx, pts);
    ctx.lineJoin = 'round';
    for (const w of [46, 34, 22, 12]) {
        ctx.lineWidth = w;
        ctx.strokeStyle = 'rgba(43,29,16,0.30)';
        ctx.stroke();
        ctx.lineWidth = w - 2.5;
        ctx.strokeStyle = w === 12 ? 'rgba(214,224,205,1)' : 'rgba(201,210,189,1)';
        ctx.stroke();
    }
    ctx.fillStyle = PAPER;
    ctx.fill();

    // Inner coast shading.
    ctx.save();
    ctx.clip();
    ctx.lineWidth = 26;
    ctx.strokeStyle = 'rgba(160,120,60,0.18)';
    ctx.stroke();
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(160,120,60,0.18)';
    ctx.stroke();
    ctx.restore();

    ctx.lineWidth = 3.2;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
}

/** Mottling, grain, stains, folds and a burnt edge, laid over everything. */
function ageThePaper(ctx) {
    const rand = rng('paper');
    ctx.save();
    for (let i = 0; i < 40; i++) {
        const x = rand() * CARD_W, y = rand() * CARD_H, r = 60 + rand() * 180;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const dark = rand() < 0.6;
        g.addColorStop(0, dark ? 'rgba(120,80,30,0.07)' : 'rgba(255,248,225,0.08)');
        g.addColorStop(1, 'rgba(120,80,30,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 5000; i++) {
        ctx.fillStyle = rand() < 0.55 ? 'rgba(90,60,20,0.08)' : 'rgba(255,255,240,0.09)';
        ctx.fillRect(rand() * CARD_W, rand() * CARD_H, 1.4, 1.4);
    }

    // A tea ring someone left on the chart.
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(120,70,20,0.10)';
    ctx.beginPath();
    ctx.arc(CARD_W * 0.8, CARD_H * 0.82, 70, 0.3, Math.PI * 1.85);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(CARD_W * 0.8 + 3, CARD_H * 0.82 - 2, 64, 0.1, Math.PI * 1.5);
    ctx.stroke();

    // Fold creases: a crisp light edge beside a soft shadow.
    for (const [x1, y1, x2, y2] of [[CARD_W / 2, 0, CARD_W / 2, CARD_H], [0, CARD_H / 2, CARD_W, CARD_H / 2]]) {
        const vertical = x1 === x2;
        ctx.lineWidth = 10;
        ctx.strokeStyle = 'rgba(100,70,30,0.05)';
        ctx.beginPath();
        ctx.moveTo(x1 + (vertical ? 4 : 0), y1 + (vertical ? 0 : 4));
        ctx.lineTo(x2 + (vertical ? 4 : 0), y2 + (vertical ? 0 : 4));
        ctx.stroke();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(255,250,235,0.35)';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }

    const v = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, CARD_H * 0.42, CARD_W / 2, CARD_H / 2, CARD_W * 0.66);
    v.addColorStop(0, 'rgba(80,45,10,0)');
    v.addColorStop(1, 'rgba(80,45,10,0.42)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.restore();
}

/** The neatline: a margin, double rule and an alternating scale-bar border. */
function paintBorder(ctx) {
    ctx.save();
    ctx.fillStyle = PAPER_DARK;
    ctx.fillRect(0, 0, CARD_W, BORDER);
    ctx.fillRect(0, CARD_H - BORDER, CARD_W, BORDER);
    ctx.fillRect(0, 0, BORDER, CARD_H);
    ctx.fillRect(CARD_W - BORDER, 0, BORDER, CARD_H);

    const w = CARD_W - BORDER * 2, h = CARD_H - BORDER * 2;
    ctx.fillStyle = PAPER_LIGHT;
    ctx.fillRect(BORDER, BORDER, w, 14);
    ctx.fillRect(BORDER, CARD_H - BORDER - 14, w, 14);
    ctx.fillRect(BORDER, BORDER, 14, h);
    ctx.fillRect(CARD_W - BORDER - 14, BORDER, 14, h);

    // Scale bar: alternating inked blocks along the middle of the band.
    ctx.fillStyle = INK;
    const seg = 30;
    for (let x = BORDER + 14, i = 0; x < CARD_W - BORDER - 14; x += seg, i++) {
        if (i % 2) continue;
        const ww = Math.min(seg, CARD_W - BORDER - 14 - x);
        ctx.fillRect(x, BORDER + 4, ww, 6);
        ctx.fillRect(x, CARD_H - BORDER - 10, ww, 6);
    }
    for (let y = BORDER + 14, i = 0; y < CARD_H - BORDER - 14; y += seg, i++) {
        if (i % 2) continue;
        const hh = Math.min(seg, CARD_H - BORDER - 14 - y);
        ctx.fillRect(BORDER + 4, y, 6, hh);
        ctx.fillRect(CARD_W - BORDER - 10, y, 6, hh);
    }

    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.strokeRect(BORDER, BORDER, w, h);
    ctx.lineWidth = 1.2;
    ctx.strokeRect(INNER, INNER, CARD_W - INNER * 2, CARD_H - INNER * 2);
    ctx.strokeRect(BORDER - 7, BORDER - 7, w + 14, h + 14);
    ctx.restore();
}

// ─── Terrain ─────────────────────────────────────────────────────────────────
// Each draws one symbol at (x, y), size s. `tint` is the wash colour for a
// charted region or null for a pencilled one; `alpha` fades a pencilled one.

function hatch(ctx, x0, y0, x1, y1, gap, angle = 0.9) {
    // Parallel diagonal strokes over the current clip.
    ctx.beginPath();
    const span = Math.max(x1 - x0, y1 - y0) * 2;
    for (let d = -span; d < span; d += gap) {
        ctx.moveTo(x0 + d, y1);
        ctx.lineTo(x0 + d + (y1 - y0) * angle, y0);
    }
    ctx.stroke();
}

const TERRAIN = {
    forest(ctx, x, y, s, fill, v) {
        // A rounded canopy: three lobes, shaded on its right, on a short trunk.
        ctx.beginPath();
        ctx.moveTo(x, y + s * 0.55);
        ctx.lineTo(x, y + s * 1.05);
        ctx.lineWidth = 1.6;
        ctx.stroke();
        const canopy = () => {
            ctx.beginPath();
            ctx.arc(x - s * 0.35, y + s * 0.1, s * 0.5, Math.PI * 0.5, Math.PI * 1.5);
            ctx.arc(x, y - s * 0.3, s * 0.55, Math.PI * 1.05, Math.PI * 1.95);
            ctx.arc(x + s * 0.35, y + s * 0.1, s * 0.5, Math.PI * 1.5, Math.PI * 0.5);
            ctx.closePath();
        };
        canopy();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.lineWidth = 1;
        hatch(ctx, x + s * (0.05 + v * 0.1), y - s, x + s, y + s, 3.6, 0.7);
        ctx.restore();
        // hatch() left its own path current; the outline needs the canopy back.
        canopy();
        ctx.lineWidth = 1.6;
        ctx.stroke();
    },
    conifer(ctx, x, y, s, fill) {
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.45, y + s * 0.1);
        ctx.lineTo(x + s * 0.25, y + s * 0.1);
        ctx.lineTo(x + s * 0.6, y + s * 0.75);
        ctx.lineTo(x - s * 0.6, y + s * 0.75);
        ctx.lineTo(x - s * 0.25, y + s * 0.1);
        ctx.lineTo(x - s * 0.45, y + s * 0.1);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + s * 0.75);
        ctx.lineTo(x, y + s * 1.05);
        ctx.stroke();
    },
    mountains(ctx, x, y, s, fill, v, snow) {
        // A peak with a lit left face and a hatched right face.
        const h = s * (1.2 + v * 0.6), w = s * (1.1 + v * 0.3);
        const px = x + (v - 0.5) * s * 0.3;
        ctx.beginPath();
        ctx.moveTo(x - w, y + s * 0.5);
        ctx.quadraticCurveTo(px - w * 0.4, y - h * 0.3, px, y - h);
        ctx.quadraticCurveTo(px + w * 0.35, y - h * 0.35, x + w, y + s * 0.5);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(px, y - h);
        ctx.quadraticCurveTo(px + w * 0.05, y - h * 0.2, x + w * 0.15, y + s * 0.5);
        ctx.lineTo(x + w * 1.2, y + s * 0.5);
        ctx.lineTo(x + w * 1.2, y - h);
        ctx.closePath();
        ctx.fillStyle = 'rgba(43,29,16,0.16)';
        ctx.fill();
        ctx.lineWidth = 1;
        hatch(ctx, px - s * 0.1, y - h, x + w, y + s * 0.5, 3.4, -0.9);
        ctx.restore();
        if (snow) {
            ctx.beginPath();
            ctx.moveTo(px, y - h);
            ctx.lineTo(px - w * 0.28, y - h * 0.55);
            ctx.lineTo(px - w * 0.1, y - h * 0.62);
            ctx.lineTo(px + w * 0.05, y - h * 0.5);
            ctx.lineTo(px + w * 0.2, y - h * 0.6);
            ctx.closePath();
            ctx.fillStyle = '#fbf8f0';
            ctx.fill();
        }
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(x - w, y + s * 0.5);
        ctx.quadraticCurveTo(px - w * 0.4, y - h * 0.3, px, y - h);
        ctx.quadraticCurveTo(px + w * 0.35, y - h * 0.35, x + w, y + s * 0.5);
        ctx.stroke();
    },
    ruins(ctx, x, y, s, fill, v) {
        const kind = Math.floor(v * 3);
        ctx.lineWidth = 1.5;
        ctx.fillStyle = fill;
        if (kind === 0) {
            // An arch.
            ctx.beginPath();
            ctx.moveTo(x - s * 0.7, y + s * 0.6);
            ctx.lineTo(x - s * 0.7, y - s * 0.2);
            ctx.arc(x, y - s * 0.2, s * 0.7, Math.PI, 0);
            ctx.lineTo(x + s * 0.7, y + s * 0.6);
            ctx.lineTo(x + s * 0.35, y + s * 0.6);
            ctx.lineTo(x + s * 0.35, y - s * 0.2);
            ctx.arc(x, y - s * 0.2, s * 0.35, 0, Math.PI, true);
            ctx.lineTo(x - s * 0.35, y + s * 0.6);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        } else {
            // A colonnade, one column broken.
            const cols = kind === 1 ? 3 : 2;
            for (let i = 0; i < cols; i++) {
                const cx = x + (i - (cols - 1) / 2) * s * 0.55;
                const top = i === cols - 1 ? y - s * 0.1 : y - s * 0.7;
                ctx.beginPath();
                ctx.rect(cx - s * 0.14, top, s * 0.28, y + s * 0.6 - top);
                ctx.fill();
                ctx.stroke();
                if (i === cols - 1) {
                    ctx.beginPath();
                    ctx.moveTo(cx - s * 0.14, top);
                    ctx.lineTo(cx - s * 0.02, top - s * 0.12);
                    ctx.lineTo(cx + s * 0.14, top + s * 0.04);
                    ctx.stroke();
                }
            }
            ctx.beginPath();
            ctx.moveTo(x - s * 0.8, y + s * 0.6);
            ctx.lineTo(x + s * 0.8, y + s * 0.6);
            ctx.stroke();
            if (kind === 1) {
                ctx.beginPath();
                ctx.rect(x - s * 0.8, y - s * 0.84, s * 1.05, s * 0.14);
                ctx.fill();
                ctx.stroke();
            }
        }
    },
    harbour(ctx, x, y, s, fill, v) {
        if (v < 0.45) {
            // A cottage.
            ctx.lineWidth = 1.5;
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.rect(x - s * 0.45, y - s * 0.1, s * 0.9, s * 0.6);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - s * 0.6, y - s * 0.1);
            ctx.lineTo(x, y - s * 0.65);
            ctx.lineTo(x + s * 0.6, y - s * 0.1);
            ctx.closePath();
            ctx.fillStyle = 'rgba(43,29,16,0.35)';
            ctx.fill();
            ctx.stroke();
        } else if (v < 0.75) {
            // A pier on pilings.
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(x - s, y);
            ctx.lineTo(x + s, y);
            ctx.moveTo(x - s, y - 3);
            ctx.lineTo(x + s, y - 3);
            for (let i = -2; i <= 2; i++) {
                ctx.moveTo(x + i * s * 0.45, y);
                ctx.lineTo(x + i * s * 0.45, y + s * 0.5);
            }
            ctx.stroke();
        } else {
            // A little boat.
            ctx.lineWidth = 1.5;
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.moveTo(x - s * 0.7, y);
            ctx.quadraticCurveTo(x, y + s * 0.5, x + s * 0.7, y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - s * 0.9);
            ctx.lineTo(x + s * 0.5, y - s * 0.15);
            ctx.closePath();
            ctx.stroke();
        }
    },
    wastes(ctx, x, y, s, fill, v) {
        if (v < 0.3) {
            // A crater.
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.ellipse(x, y, s * 0.7, s * 0.3, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(43,29,16,0.12)';
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.ellipse(x, y - s * 0.06, s * 0.45, s * 0.16, 0, Math.PI * 1.05, Math.PI * 1.95);
            ctx.stroke();
        } else if (v < 0.5) {
            star(ctx, x, y, s * 0.5, fill, 4, 1.2);
        } else {
            TERRAIN.dunes(ctx, x, y, s);
        }
    },
    dunes(ctx, x, y, s) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - s, y + s * 0.3);
        ctx.quadraticCurveTo(x - s * 0.3, y - s * 0.45, x + s * 0.3, y + s * 0.3);
        ctx.moveTo(x - s * 0.1, y + s * 0.05);
        ctx.quadraticCurveTo(x + s * 0.4, y - s * 0.4, x + s, y + s * 0.3);
        ctx.stroke();
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x - s * 0.3, y);
        ctx.lineTo(x - s * 0.1, y + s * 0.28);
        ctx.moveTo(x - s * 0.18, y - s * 0.08);
        ctx.lineTo(x + s * 0.02, y + s * 0.26);
        ctx.stroke();
    },
    hills(ctx, x, y, s, fill) {
        ctx.lineWidth = 1.6;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(x - s, y + s * 0.4);
        ctx.quadraticCurveTo(x - s * 0.2, y - s * 0.9, x + s * 0.6, y + s * 0.4);
        ctx.fill();
        ctx.stroke();
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(x + s * 0.05, y - s * 0.1);
        ctx.lineTo(x + s * 0.25, y + s * 0.3);
        ctx.moveTo(x + s * 0.2, y);
        ctx.lineTo(x + s * 0.38, y + s * 0.32);
        ctx.stroke();
    },
};

function star(ctx, x, y, r, fill, points = 5, lineWidth = 1.3) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * (points === 4 ? 0.34 : 0.45);
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
}

/** How big and how dense each kind of terrain is drawn. */
const TERRAIN_SCALE = {
    forest:    { size: 15, spacing: 25 },
    mountains: { size: 17, spacing: 38 },
    ruins:     { size: 15, spacing: 40 },
    harbour:   { size: 15, spacing: 38 },
    wastes:    { size: 15, spacing: 38 },
    dunes:     { size: 16, spacing: 34 },
    hills:     { size: 16, spacing: 32 },
};

function drawTerrain(ctx, pts, place, tint, pencil, seed) {
    const kind = place.terrain in TERRAIN ? place.terrain : 'hills';
    const scale = TERRAIN_SCALE[kind];
    const inset = blobPoints(place.x, place.y, place.r * 0.86, seed, 20, 0.22);
    const spots = fillPoints(ctx, inset, scale.spacing, `${seed}:terrain`, [
        place.x - place.r, place.y - place.r, place.x + place.r, place.y + place.r,
    ]);
    let fill = tint ? shade(tint, 0.35) : PAPER_LIGHT;
    if (place.dark && tint) fill = shade(tint, -0.2);
    const draw = place.dark ? TERRAIN.conifer : TERRAIN[kind];

    ctx.save();
    ctx.strokeStyle = INK;
    ctx.globalAlpha = pencil ? 0.42 : 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [x, y, v] of spots) {
        draw(ctx, x, y, scale.size * (0.85 + v * 0.3), fill, v, place.snow);
    }
    ctx.restore();
}

// ─── Regions ─────────────────────────────────────────────────────────────────

/** A watercolour wash: pooled, uneven colour with a darker dried edge. */
function wash(ctx, pts, place, color, strength, seed) {
    const rand = rng(`${seed}:wash`);
    ctx.save();
    tracePath(ctx, pts);
    ctx.clip();
    ctx.fillStyle = rgba(color, 0.22 * strength + 0.08);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
        const blob = blobPoints(
            place.x + (rand() - 0.5) * place.r * 0.6,
            place.y + (rand() - 0.5) * place.r * 0.5,
            place.r * (0.45 + rand() * 0.4), `${seed}:wash${i}`, 14, 0.4,
        );
        tracePath(ctx, blob);
        ctx.fillStyle = rgba(color, 0.1 * strength + 0.04);
        ctx.fill();
    }
    tracePath(ctx, pts);
    ctx.lineWidth = 12;
    ctx.strokeStyle = rgba(shade(color, -0.2), 0.28 * strength + 0.1);
    ctx.stroke();
    ctx.restore();
}

/**
 * Terra incognita: a bank of inked clouds, outlined only on its silhouette,
 * with hatched undersides.
 */
function drawClouds(ctx, place, seed) {
    const rand = rng(`${seed}:clouds`);
    const puffs = [];
    const rows = 3;
    for (let row = 0; row < rows; row++) {
        const y = place.y - place.r * 0.42 + row * place.r * 0.38;
        const span = place.r * (row === 1 ? 1.0 : 0.78);
        const n = row === 1 ? 5 : 4;
        for (let i = 0; i < n; i++) {
            const x = place.x - span + (i / (n - 1)) * span * 2 + (rand() - 0.5) * 10;
            puffs.push([x, y + (rand() - 0.5) * 10, place.r * (0.26 + rand() * 0.1)]);
        }
    }
    const trace = () => {
        ctx.beginPath();
        for (const [x, y, r] of puffs) {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
        }
    };
    ctx.save();
    trace();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = PAPER_LIGHT;
    ctx.fill();
    // Hatched undersides, each puff shaded low and right.
    ctx.clip();
    ctx.strokeStyle = 'rgba(43,29,16,0.4)';
    ctx.lineWidth = 1;
    for (const [x, y, r] of puffs) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + r * 0.35, y + r * 0.45, r * 0.75, 0, Math.PI * 2);
        ctx.clip();
        hatch(ctx, x - r, y - r, x + r * 1.5, y + r * 1.5, 4, 1);
        ctx.restore();
    }
    // A soft inner outline on each puff's top edge, for the scalloped look.
    ctx.strokeStyle = 'rgba(43,29,16,0.45)';
    ctx.lineWidth = 1.4;
    for (const [x, y, r] of puffs) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.98, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
    }
    ctx.restore();
}

function drawPins(ctx, state, place, seed) {
    const [found, total] = state.landmarks;
    const rand = rng(`${seed}:pins`);
    const pins = [];
    for (let i = 0; i < total; i++) {
        const a = (i / total) * Math.PI * 2 + rand() * 0.6 - Math.PI / 2;
        const d = place.r * (0.3 + rand() * 0.32);
        pins.push([place.x + Math.cos(a) * d, place.y + Math.sin(a) * d * 0.72]);
    }
    pins.forEach(([x, y], i) => {
        ctx.save();
        if (i < found) {
            // A red ink map pin with a paper halo.
            ctx.beginPath();
            ctx.arc(x, y, 11, 0, Math.PI * 2);
            ctx.fillStyle = rgba(PAPER_LIGHT, 0.85);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, 7.5, 0, Math.PI * 2);
            ctx.fillStyle = PIN_RED;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = INK;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 2.4, 0, Math.PI * 2);
            ctx.fillStyle = PAPER_LIGHT;
            ctx.fill();
        } else {
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.fillStyle = rgba(PAPER_LIGHT, 0.7);
            ctx.fill();
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1.6;
            ctx.strokeStyle = INK_MID;
            ctx.stroke();
        }
        ctx.restore();
    });

    const [secrets] = state.secrets;
    for (let i = 0; i < secrets; i++) {
        const a = (i / Math.max(secrets, 1)) * Math.PI * 2 + Math.PI / 4 + rand() * 0.5;
        const d = place.r * (0.15 + rand() * 0.2);
        const x = place.x + Math.cos(a) * d, y = place.y + Math.sin(a) * d * 0.72;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fillStyle = rgba(PAPER_LIGHT, 0.75);
        ctx.fill();
        ctx.restore();
        star(ctx, x, y, 10, GOLD, 5, 1.4);
    }
}

/** A wax seal, pressed with a star: the mark of a fully surveyed region. */
function drawSeal(ctx, x, y, r, seed) {
    const rand = rng(`${seed}:seal`);
    ctx.save();
    ctx.shadowColor = 'rgba(40,10,5,0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        const rr = r * (0.92 + rand() * 0.16);
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    g.addColorStop(0, '#b8342c');
    g.addColorStop(1, SEAL_RED);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.68, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(60,8,5,0.6)';
    ctx.stroke();
    ctx.restore();
    star(ctx, x, y, r * 0.48, '#c8463c', 5, 1);
}

function regionColor(region, place) {
    return place.dark ? shade(region.color, -0.35) : region.color;
}

/**
 * One region, in one of two layers: 'base' (wash, terrain, border) goes under
 * the trail, 'marks' (clouds, pins, lettering, seal) over it.
 */
function drawRegion(ctx, state, place, layer) {
    const { region } = state;
    const seed = region.id;
    const compact = Boolean(place.island);
    const nameSize = compact ? 22 : 34;
    // Labels sit under a region unless its layout puts them beside it.
    const side = place.label === 'right' || place.label === 'left' ? place.label : null;
    const labelX = side === 'right' ? place.x + place.r * 1.3 + 8 : side === 'left' ? place.x - place.r * 1.3 - 8 : place.x;
    const labelAlign = side === 'right' ? 'left' : side === 'left' ? 'right' : 'center';
    const labelY = side ? place.y - 10
        : place.label === 'above' ? place.y - place.r * 0.8 - (compact ? 48 : 58)
            : place.y + place.r * 0.8 + (compact ? 20 : 24);

    if (state.status === 'locked') {
        if (layer !== 'marks') return;
        drawClouds(ctx, place, seed);
        letter(ctx, 'Terra Incognita', place.x, place.y - 2, {
            font: `italic ${compact ? 22 : 28}px ${SERIF}`, color: INK, halo: PAPER_LIGHT,
        });
        letter(ctx, `Explorer Lv ${region.unlockLevel}`, place.x, place.y + (compact ? 24 : 30), {
            font: `${compact ? 20 : 24}px ${SERIF_SC}`, color: INK_MID, halo: PAPER_LIGHT,
        });
        return;
    }

    const pts = blobPoints(place.x, place.y, place.r, seed);
    const charted = state.status === 'charted';
    const color = regionColor(region, place);

    if (layer === 'base') {
        if (charted) wash(ctx, pts, place, color, 0.5 + state.pct / 200, seed);
        drawTerrain(ctx, pts, place, charted ? color : null, !charted, seed);

        // The region's border: a dotted ink line, pencil-faint until walked.
        ctx.save();
        tracePath(ctx, pts);
        ctx.setLineDash(charted ? [1, 6] : [1, 8]);
        ctx.lineCap = 'round';
        ctx.lineWidth = charted ? 3.2 : 2.4;
        ctx.strokeStyle = charted ? INK : INK_SOFT;
        ctx.stroke();
        ctx.restore();
        return;
    }

    if (charted) drawPins(ctx, state, place, seed);

    const name = plain(region.name);
    const box = letter(ctx, name, labelX, labelY, {
        font: `${nameSize}px ${SERIF_SC}`, spacing: compact ? 1 : 3, max: compact ? 240 : 330, align: labelAlign,
        color: charted ? INK : INK_MID, haloWidth: 9,
    });

    let sub;
    if (!charted) sub = state.seasonal ? 'in season — go look' : 'route open, never walked';
    else if (state.surveyed) sub = 'fully surveyed';
    else sub = `${state.pct}% charted`;
    if (charted && state.seasonal && !state.inSeason) sub = `${state.surveyed ? 'surveyed' : `${state.pct}%`} · out of season`;
    letter(ctx, sub, labelX, labelY + (compact ? 24 : 32), {
        font: `italic ${compact ? 19 : 25}px ${SERIF}`, color: state.surveyed ? SEAL_RED : INK_MID, max: 280, align: labelAlign,
    });

    if (state.surveyed) {
        // The seal sits just past the name's far end, or on the island's shoulder when the name is beside it.
        // Past the name's end, or before its start when the name is hard against the east edge.
        const r = compact ? 16 : 21;
        const gap = r + 8;
        const fitsRight = box.right + gap + r < CARD_W - INNER - 6;
        const sealX = side ? place.x + place.r * 0.7 : fitsRight ? box.right + gap : box.left - gap;
        const sealY = side ? place.y - place.r * 0.6 : labelY + 2;
        drawSeal(ctx, sealX, sealY, r, seed);
    }
}

function drawYouAreHere(ctx, place) {
    const x = place.x, y = place.y;
    ctx.save();
    ctx.lineCap = 'round';
    for (const [w, c] of [[16, rgba(PAPER_LIGHT, 0.9)], [10, INK], [6, PIN_RED]]) {
        ctx.lineWidth = w;
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(x - 15, y - 15);
        ctx.lineTo(x + 15, y + 15);
        ctx.moveTo(x + 15, y - 15);
        ctx.lineTo(x - 15, y + 15);
        ctx.stroke();
    }
    ctx.restore();
}

// ─── Trail, compass, sea decoration, title ───────────────────────────────────

function trailCurve(from, to) {
    const rand = rng(`${from.x},${from.y}:${to.x},${to.y}`);
    const mx = (from.x + to.x) / 2 + (rand() - 0.5) * 80;
    const my = (from.y + to.y) / 2 + (rand() - 0.5) * 80;
    return [from, { x: mx, y: my }, to];
}

function drawTrail(ctx, legs) {
    for (const { from, to, walked } of legs) {
        const [a, m, b] = trailCurve(from, to);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(m.x, m.y, b.x, b.y);
        if (walked) {
            ctx.setLineDash([12, 9]);
            ctx.lineWidth = 8;
            ctx.strokeStyle = rgba(PAPER_LIGHT, 0.8);
            ctx.stroke();
            ctx.lineWidth = 4;
            ctx.strokeStyle = PIN_RED;
        } else {
            ctx.setLineDash([2, 10]);
            ctx.lineWidth = 3;
            ctx.strokeStyle = INK_SOFT;
        }
        ctx.stroke();
        ctx.restore();
    }
}

function drawCompass(ctx, { x, y, r }) {
    ctx.save();
    // Rings, with a degree scale between them.
    ctx.beginPath();
    ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
    ctx.fillStyle = rgba(PAPER_LIGHT, 0.7);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.stroke();
    for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        const inner = i % 4 === 0 ? r * 0.82 : r * 0.88;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
        ctx.lineTo(x + Math.cos(a) * r * 0.95, y + Math.sin(a) * r * 0.95);
        ctx.stroke();
    }

    // Sixteen points in three lengths, each split light and dark.
    const point = (a, len, width) => {
        const tip = [x + Math.cos(a) * len, y + Math.sin(a) * len];
        const l = [x + Math.cos(a - Math.PI / 2) * width, y + Math.sin(a - Math.PI / 2) * width];
        const rr = [x + Math.cos(a + Math.PI / 2) * width, y + Math.sin(a + Math.PI / 2) * width];
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(...l); ctx.lineTo(...tip); ctx.closePath();
        ctx.fillStyle = PAPER_LIGHT; ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(...rr); ctx.lineTo(...tip); ctx.closePath();
        ctx.fillStyle = INK; ctx.fill(); ctx.stroke();
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK;
    for (let i = 0; i < 16; i++) {
        if (i % 2 === 0) continue;
        point((i / 16) * Math.PI * 2 - Math.PI / 2, r * 0.6, r * 0.06);
    }
    for (let i = 0; i < 8; i += 2) point(((i + 1) / 8) * Math.PI * 2 - Math.PI / 2, r * 0.78, r * 0.1);
    for (let i = 0; i < 4; i++) point((i / 4) * Math.PI * 2 - Math.PI / 2, r * 1.15, r * 0.15);

    // North in red.
    const a = -Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a + Math.PI / 2) * r * 0.15, y);
    ctx.lineTo(x, y - r * 1.15);
    ctx.closePath();
    ctx.fillStyle = PIN_RED;
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y, r * 0.08, 0, Math.PI * 2);
    ctx.fillStyle = GOLD;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    letter(ctx, 'N', x, y - r * 1.15 - 20, { font: `bold 30px ${DISPLAY}`, halo: null });
}

/** A little inked ship under sail, riding the waves. */
function drawShip(ctx, x, y, s) {
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.fillStyle = PAPER_LIGHT;
    // Hull.
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x + s * 1.1, y - s * 0.1);
    ctx.quadraticCurveTo(x + s * 0.8, y + s * 0.45, x + s * 0.5, y + s * 0.45);
    ctx.lineTo(x - s * 0.6, y + s * 0.45);
    ctx.quadraticCurveTo(x - s * 0.85, y + s * 0.3, x - s, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.lineWidth = 1;
    hatch(ctx, x - s, y, x + s * 1.1, y + s * 0.5, 3.5, 0.8);
    ctx.restore();
    // Masts and bellied sails.
    for (const [mx, h] of [[-0.35, 1.3], [0.35, 1.6]]) {
        const px = x + mx * s;
        ctx.beginPath();
        ctx.moveTo(px, y);
        ctx.lineTo(px, y - h * s);
        ctx.stroke();
        for (const [top, bot] of [[h * 0.95, h * 0.55], [h * 0.5, h * 0.12]]) {
            ctx.beginPath();
            ctx.moveTo(px - s * 0.32, y - top * s);
            ctx.quadraticCurveTo(px + s * 0.05, y - (top - 0.1) * s, px + s * 0.32, y - top * s);
            ctx.quadraticCurveTo(px + s * 0.42, y - ((top + bot) / 2) * s, px + s * 0.32, y - bot * s);
            ctx.quadraticCurveTo(px + s * 0.05, y - (bot - 0.1) * s, px - s * 0.32, y - bot * s);
            ctx.quadraticCurveTo(px - s * 0.2, y - ((top + bot) / 2) * s, px - s * 0.32, y - top * s);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    }
    // Pennant.
    ctx.beginPath();
    ctx.moveTo(x + 0.35 * s, y - 1.6 * s);
    ctx.lineTo(x + 0.75 * s, y - 1.5 * s);
    ctx.lineTo(x + 0.35 * s, y - 1.42 * s);
    ctx.fillStyle = PIN_RED;
    ctx.fill();
    ctx.stroke();
    // Wake.
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x - s * (1.2 + i * 0.35), y + s * (0.3 + i * 0.12));
        ctx.quadraticCurveTo(x - s * (0.9 + i * 0.35), y + s * (0.2 + i * 0.12), x - s * (0.6 + i * 0.35), y + s * (0.35 + i * 0.12));
        ctx.stroke();
    }
    ctx.restore();
}

/** A sea serpent's coils breaking the surface — here be the unexplored. */
function drawSerpent(ctx, x, y, s) {
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    ctx.fillStyle = '#6f8a6a';
    for (let i = 0; i < 3; i++) {
        const cx = x + i * s * 1.1;
        const h = s * (0.75 - i * 0.12);
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.4, y);
        ctx.bezierCurveTo(cx - s * 0.4, y - h, cx + s * 0.4, y - h, cx + s * 0.4, y);
        ctx.lineTo(cx + s * 0.22, y);
        ctx.bezierCurveTo(cx + s * 0.22, y - h * 0.6, cx - s * 0.22, y - h * 0.6, cx - s * 0.22, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }
    // Head.
    const hx = x - s * 0.9;
    ctx.beginPath();
    ctx.moveTo(hx + s * 0.55, y);
    ctx.bezierCurveTo(hx + s * 0.5, y - s * 0.9, hx - s * 0.2, y - s * 1.0, hx - s * 0.5, y - s * 0.7);
    ctx.lineTo(hx - s * 0.2, y - s * 0.55);
    ctx.bezierCurveTo(hx, y - s * 0.6, hx + s * 0.25, y - s * 0.5, hx + s * 0.3, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx - s * 0.1, y - s * 0.75, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    // Splash.
    ctx.lineWidth = 1.3;
    for (let i = -1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * s * 1.1 - s * 0.6, y + 3);
        ctx.quadraticCurveTo(x + i * s * 1.1 - s * 0.3, y - 3, x + i * s * 1.1, y + 3);
        ctx.stroke();
    }
    ctx.restore();
}

/** The title on a curling ribbon banner, top left. */
function drawBanner(ctx, username, level) {
    const x = INNER + 26, y = INNER + 20, w = 440, h = 64;
    const tail = 34;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;

    // Folded tails behind the band.
    for (const side of [-1, 1]) {
        const ex = side < 0 ? x : x + w;
        ctx.beginPath();
        ctx.moveTo(ex - side * 10, y + 16);
        ctx.lineTo(ex + side * tail, y + 16);
        ctx.lineTo(ex + side * (tail - 14), y + 16 + h / 2);
        ctx.lineTo(ex + side * tail, y + 16 + h);
        ctx.lineTo(ex - side * 10, y + 16 + h);
        ctx.closePath();
        ctx.fillStyle = PAPER_DARK;
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex, y + h);
        ctx.lineTo(ex - side * 10, y + 16 + h);
        ctx.lineTo(ex - side * 10, y + h);
        ctx.closePath();
        ctx.fillStyle = '#b89a62';
        ctx.fill();
        ctx.stroke();
    }

    // The band itself, gently bowed.
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + w / 2, y + 12, x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.quadraticCurveTo(x + w / 2, y + h + 12, x, y + h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, PAPER_LIGHT);
    g.addColorStop(1, '#e6d3a4');
    ctx.fillStyle = g;
    ctx.shadowColor = 'rgba(60,35,10,0.3)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
    ctx.restore();

    letter(ctx, "The Explorer's Map", x + w / 2, y + h / 2 + 5, {
        font: `bold 34px ${DISPLAY}`, halo: null, max: w - 30,
    });

    const by = username ? `as charted by ${username}` : 'as charted by an explorer';
    letter(ctx, level ? `${by}, Explorer Lv ${level}` : by, x + w / 2, y + h + 38, {
        font: `italic 25px ${SERIF}`, color: INK, max: w + 40, haloWidth: 8,
    });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Gives every visible region a place: its own, or the next spare slot. */
function placeRegions(states) {
    let spare = 0;
    return states.map(state => {
        const own = LAYOUT[state.region.id];
        const place = own ?? { ...(SPARE_SLOTS[spare++ % SPARE_SLOTS.length]), terrain: 'hills', island: true };
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
 * @returns {Promise<Buffer>}  PNG
 */
// The parts of the chart that are the same for every player — the sea, the
// continent, the compass, and the aged paper and border laid over the top —
// are drawn once and reused. They are most of the drawing, and all of it runs
// on the main thread (only the PNG encode leaves it; see utils/canvasEncode.js).
let backdrop = null;
let overlay = null;

function getBackdrop() {
    if (backdrop) return backdrop;
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    paintSea(ctx);
    drawShip(ctx, 855, 772, 24);
    drawSerpent(ctx, 470, 770, 20);
    letter(ctx, 'The Unquiet Sea', 690, 772, { font: `italic 26px ${SERIF}`, color: INK_MID, halo: null, spacing: 2 });
    paintLand(ctx, roughen(CONTINENT, 'continent'));
    drawCompass(ctx, COMPASS);
    backdrop = canvas;
    return backdrop;
}

function getOverlay() {
    if (overlay) return overlay;
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    ageThePaper(ctx);
    paintBorder(ctx);
    overlay = canvas;
    return overlay;
}

async function createExploreMapCard({ states, username, level }) {
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const placed = placeRegions(states ?? []);

    ctx.drawImage(getBackdrop(), 0, 0);
    for (const { place } of placed) {
        if (!place.island) continue;
        const key = `${place.x}:${place.y}`;
        paintLand(ctx, roughen(blobPoints(place.x, place.y, place.r * 1.3, key, 10, 0.3), key, 10, 3));
    }

    // The trail runs through the core regions in the order their routes open;
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

    // Terrain and washes first, then the trail over them, then clouds, pins
    // and lettering on top so nothing buries a name.
    for (const { state, place } of placed) drawRegion(ctx, state, place, 'base');
    drawTrail(ctx, legs);
    const here = placed.find(p => p.state.active && p.state.status !== 'locked');
    if (here) drawYouAreHere(ctx, here.place);
    // Clouds before any lettering, so a fog bank never swallows a neighbour's name.
    const cloudsFirst = [...placed].sort((a, b) => (a.state.status === 'locked' ? 0 : 1) - (b.state.status === 'locked' ? 0 : 1));
    for (const { state, place } of cloudsFirst) drawRegion(ctx, state, place, 'marks');

    ctx.drawImage(getOverlay(), 0, 0);
    drawBanner(ctx, plain(username), level);

    return encodeCanvas(canvas);
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
    CARD_W,
    CARD_H,
    LAYOUT,
    __test__: { plain, placeRegions, hashSeed },
};
