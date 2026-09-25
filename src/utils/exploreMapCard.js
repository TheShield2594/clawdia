'use strict';

/**
 * The Explorer's Map, drawn: the picture `/explore map` puts above its text.
 *
 *   ╔══════════════════════════════════════════════════════════════════════╗
 *   ║ ┌ THE EXPLORER'S MAP ┐                         ~~~  ☁☁ ??? ☁☁   ~~~  ║
 *   ║ └ charted by munge  ┘        ▲▲ CRYSTAL CAVES          ~~~   ~~~     ║
 *   ║      ☁☁ ??? ☁☁           ·····                ·····            ~~~   ║
 *   ║                    ▥ ▥ CRUMBLING RUINS              ⚓ SUNKEN DOCKS    ║
 *   ║    ♣♣ WHISPERING  ····                                          ~~~  ║
 *   ║    ♣♣ FOREST  ✕                     ✦ STARFALL WASTES          ~~~   ║
 *   ║  ✧ N                                                                 ║
 *   ║  LANDMARK ◆ FOUND ◇ UNFOUND  ✦ SECRET  ✕ YOU ARE HERE                 ║
 *   ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Every core region has a fixed place on one continent, joined by the trail in
 * the order their routes open, so a player's map fills in the same shape as
 * everyone else's — just at their own pace. Seasonal regions are islands off
 * the coast and only surface under the same rules as the text map.
 *
 * What is visible comes from exploreService.mapRegionStates, the same source
 * the text map reads, so the picture can never show a region the text hides.
 *
 * The card-family contract holds (see utils/petStatusCard.js): this is an
 * illustration, not the record. Every number drawn here is also in the embed
 * text, callers give the file alt text, and nothing is drawn as an emoji
 * (node-canvas draws colour emoji as boxes) — the terrain is canvas strokes.
 *
 * @module utils/exploreMapCard
 */

const { createCanvas } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { primitives } = require('./grindProfileCard');

const { FONT, roundRect, fitText, shade } = primitives;

const CARD_W = 1000;
const CARD_H = 660;
const FRAME = 18;

const INK = '#3b2a1a';
const INK_SOFT = 'rgba(59,42,26,0.55)';
const INK_FAINT = 'rgba(59,42,26,0.22)';
const PARCHMENT = '#ecdcb6';
const PARCHMENT_DARK = '#d8c193';
const SEA = '#b7c8bd';
const SEA_INK = 'rgba(52,86,92,0.45)';
const FOG = 'rgba(245,242,235,';
const PIN_RED = '#a8322b';
const SECRET_GOLD = '#b8860b';

/**
 * Where each region sits and what its land looks like. Core regions trace the
 * trail west to east in unlock order; seasonal ones are offshore islands.
 * `r` is the region's radius on the map.
 */
const LAYOUT = {
    whispering_forest: { x: 215, y: 405, r: 88,  terrain: 'trees' },
    crumbling_ruins:   { x: 405, y: 290, r: 80,  terrain: 'columns' },
    crystal_caves:     { x: 590, y: 175, r: 78,  terrain: 'peaks' },
    sunken_docks:      { x: 755, y: 355, r: 80,  terrain: 'piers' },
    starfall_wastes:   { x: 545, y: 490, r: 86,  terrain: 'stars' },
    frostveil_pass:    { x: 140, y: 175, r: 52,  terrain: 'peaks',  island: true },
    arctic_tundra:     { x: 285, y: 120, r: 46,  terrain: 'peaks',  island: true },
    velvet_arcade:     { x: 905, y: 135, r: 46,  terrain: 'hearts', island: true },
    scorchglass_shore: { x: 900, y: 545, r: 50,  terrain: 'dunes',  island: true },
    hollowgrave_lane:  { x: 140, y: 555, r: 48,  terrain: 'trees',  island: true, dark: true },
};

// A region added to the data without a place here still gets one: the next
// free offshore slot, so a new seasonal region shows up before anyone draws it.
const SPARE_SLOTS = [
    { x: 330, y: 600, r: 44 },
    { x: 760, y: 590, r: 44 },
    { x: 925, y: 280, r: 40 },
];

// The land the continent covers, as a rough outline the noise roughens up.
const CONTINENT = [
    [150, 250], [250, 205], [360, 190], [470, 110], [610, 90], [700, 140],
    [760, 235], [835, 300], [840, 420], [760, 500], [690, 575], [560, 600],
    [420, 580], [300, 530], [160, 505], [95, 420], [100, 320],
];

// ─── Seeded randomness ───────────────────────────────────────────────────────
// The map must draw identically every time for the same player, so every
// wobble comes from a PRNG seeded by what it decorates, never Math.random.

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

function hexToRgba(hex, alpha) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    if (!Number.isFinite(n)) return `rgba(59,42,26,${alpha})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Strips emoji, the joiners around them and Discord formatting, which a canvas cannot draw. */
function plain(str) {
    return String(str ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/[*_~`|]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** A closed, hand-drawn looking blob around (cx, cy). */
function blobPoints(cx, cy, r, seed, n = 18, wobble = 0.22) {
    const rand = rng(seed);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (1 - wobble / 2 + rand() * wobble);
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.82]);
    }
    return pts;
}

/** Traces a smooth closed curve through `pts` (midpoint quadratic smoothing). */
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
function roughen(pts, seed, jitter = 14, steps = 4) {
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

function label(ctx, str, x, y, { size = 15, weight = 'bold', color = INK, align = 'center', max = 220, halo = true } = {}) {
    ctx.save();
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    const s = fitText(ctx, str, max);
    if (halo) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(236,220,182,0.9)';
        ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.restore();
}

// ─── Backdrop ────────────────────────────────────────────────────────────────

function paintParchment(ctx) {
    // Sea first: the whole sheet, then the land on top of it.
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Wave marks across open water.
    const rand = rng('sea');
    ctx.save();
    ctx.strokeStyle = SEA_INK;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 70; i++) {
        const x = rand() * CARD_W, y = rand() * CARD_H;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + 6, y - 5, x + 12, y);
        ctx.quadraticCurveTo(x + 18, y + 5, x + 24, y);
        ctx.stroke();
    }
    ctx.restore();
}

function paintLand(ctx, pts, seed) {
    // A shallows ring, then the land, then a double ink coastline.
    ctx.save();
    tracePath(ctx, pts);
    ctx.lineWidth = 16;
    ctx.strokeStyle = 'rgba(214,226,214,0.8)';
    ctx.stroke();
    ctx.fillStyle = PARCHMENT;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();

    // Speckle the paper inside the coast so it doesn't read as flat fill.
    ctx.save();
    tracePath(ctx, pts);
    ctx.clip();
    const rand = rng(`${seed}:speckle`);
    for (let i = 0; i < 900; i++) {
        ctx.fillStyle = rand() < 0.5 ? 'rgba(120,90,50,0.07)' : 'rgba(255,255,255,0.10)';
        const s = 1 + rand() * 2.5;
        ctx.fillRect(rand() * CARD_W, rand() * CARD_H, s, s);
    }
    ctx.restore();
}

function paintVignette(ctx) {
    const g = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, CARD_H * 0.35, CARD_W / 2, CARD_H / 2, CARD_W * 0.72);
    g.addColorStop(0, 'rgba(90,60,30,0)');
    g.addColorStop(1, 'rgba(90,60,30,0.38)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
}

function paintFrame(ctx) {
    ctx.save();
    // The margin outside the border is parchment, like the edge of the sheet.
    ctx.fillStyle = PARCHMENT_DARK;
    ctx.fillRect(0, 0, CARD_W, FRAME);
    ctx.fillRect(0, CARD_H - FRAME, CARD_W, FRAME);
    ctx.fillRect(0, 0, FRAME, CARD_H);
    ctx.fillRect(CARD_W - FRAME, 0, FRAME, CARD_H);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.strokeRect(FRAME, FRAME, CARD_W - FRAME * 2, CARD_H - FRAME * 2);
    ctx.lineWidth = 1;
    ctx.strokeRect(FRAME + 6, FRAME + 6, CARD_W - (FRAME + 6) * 2, CARD_H - (FRAME + 6) * 2);
    ctx.restore();
}

// ─── Terrain glyphs ──────────────────────────────────────────────────────────
// Little ink drawings scattered over a region, standing in for its emoji.

const GLYPHS = {
    trees(ctx, x, y, s, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.6, y + s * 0.4);
        ctx.lineTo(x - s * 0.6, y + s * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + s * 0.4);
        ctx.lineTo(x, y + s * 0.8);
        ctx.stroke();
    },
    columns(ctx, x, y, s, color) {
        ctx.fillStyle = color;
        const w = s * 0.35;
        ctx.fillRect(x - w / 2, y - s * 0.6, w, s * 1.2);
        ctx.strokeRect(x - w / 2, y - s * 0.6, w, s * 1.2);
        ctx.beginPath();
        ctx.moveTo(x - w, y - s * 0.6);
        ctx.lineTo(x + w, y - s * 0.6);
        ctx.moveTo(x - w, y + s * 0.6);
        ctx.lineTo(x + w, y + s * 0.6);
        ctx.stroke();
    },
    peaks(ctx, x, y, s, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x - s, y + s * 0.5);
        ctx.lineTo(x, y - s * 0.7);
        ctx.lineTo(x + s, y + s * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Snowcap / crystal glint.
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.7);
        ctx.lineTo(x + s * 0.3, y - s * 0.3);
        ctx.lineTo(x - s * 0.3, y - s * 0.3);
        ctx.closePath();
        ctx.fill();
    },
    piers(ctx, x, y, s) {
        ctx.beginPath();
        ctx.moveTo(x - s, y);
        ctx.lineTo(x + s, y);
        for (let i = -1; i <= 1; i++) {
            ctx.moveTo(x + i * s * 0.7, y);
            ctx.lineTo(x + i * s * 0.7, y + s * 0.6);
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - s, y + s * 0.9);
        ctx.quadraticCurveTo(x - s / 2, y + s * 0.6, x, y + s * 0.9);
        ctx.quadraticCurveTo(x + s / 2, y + s * 1.2, x + s, y + s * 0.9);
        ctx.stroke();
    },
    stars(ctx, x, y, s, color) {
        star(ctx, x, y, s * 0.7, color);
    },
    dunes(ctx, x, y, s) {
        ctx.beginPath();
        ctx.moveTo(x - s, y + s * 0.3);
        ctx.quadraticCurveTo(x - s * 0.3, y - s * 0.5, x + s * 0.2, y + s * 0.3);
        ctx.moveTo(x - s * 0.1, y + s * 0.1);
        ctx.quadraticCurveTo(x + s * 0.5, y - s * 0.4, x + s, y + s * 0.3);
        ctx.stroke();
    },
    hearts(ctx, x, y, s, color) {
        ctx.fillStyle = color;
        const k = s * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y + k);
        ctx.bezierCurveTo(x - k * 2, y - k * 0.4, x - k * 0.6, y - k * 1.6, x, y - k * 0.5);
        ctx.bezierCurveTo(x + k * 0.6, y - k * 1.6, x + k * 2, y - k * 0.4, x, y + k);
        ctx.fill();
        ctx.stroke();
    },
};

function star(ctx, x, y, r, fill, points = 4) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.38;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
}

// ─── Regions ─────────────────────────────────────────────────────────────────

/** Evenly spread, jittered points inside a region for glyphs and pins. */
function scatter(place, count, seed, inner = 0.7) {
    const rand = rng(seed);
    const pts = [];
    for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rand() * 0.8;
        const d = place.r * inner * (0.35 + rand() * 0.65);
        pts.push([place.x + Math.cos(a) * d, place.y + Math.sin(a) * d * 0.8]);
    }
    return pts;
}

function drawTerrain(ctx, place, color, seed, faded) {
    const glyph = GLYPHS[place.terrain] ?? GLYPHS.dunes;
    const count = Math.round(place.r / 11);
    ctx.save();
    ctx.globalAlpha = faded ? 0.35 : 0.9;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = INK;
    for (const [x, y] of scatter(place, count, `${seed}:terrain`, 0.75)) {
        glyph(ctx, x, y, 9, color);
    }
    ctx.restore();
}

function drawFog(ctx, place, seed) {
    const rand = rng(`${seed}:fog`);
    ctx.save();
    for (let i = 0; i < 26; i++) {
        const a = rand() * Math.PI * 2;
        const d = rand() * place.r * 0.9;
        const r = place.r * (0.28 + rand() * 0.28);
        const x = place.x + Math.cos(a) * d;
        const y = place.y + Math.sin(a) * d * 0.75;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `${FOG}0.85)`);
        g.addColorStop(1, `${FOG}0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

function drawPins(ctx, state, place, seed) {
    const [found, total] = state.landmarks;
    const pts = scatter(place, total, `${seed}:pins`, 0.62);
    pts.forEach(([x, y], i) => {
        const hit = i < found;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 7);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        if (hit) {
            ctx.fillStyle = PIN_RED;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = INK;
            ctx.stroke();
        } else {
            ctx.setLineDash([2, 2]);
            ctx.lineWidth = 1.2;
            ctx.strokeStyle = INK_SOFT;
            ctx.stroke();
        }
        ctx.restore();
    });

    const [secrets] = state.secrets;
    scatter(place, secrets, `${seed}:secrets`, 0.45).forEach(([x, y]) => star(ctx, x, y, 6, SECRET_GOLD));
}

function drawRegion(ctx, state, place) {
    const { region } = state;
    const seed = region.id;
    const color = place.dark ? shade(region.color, -0.45) : region.color;

    if (state.status === 'locked') {
        drawFog(ctx, place, seed);
        label(ctx, '? ? ?', place.x, place.y - 6, { size: 18, color: INK_SOFT });
        label(ctx, `EXPLORER LV ${region.unlockLevel}`, place.x, place.y + 16, { size: 11, weight: 'normal', color: INK_SOFT });
        return;
    }

    const pts = blobPoints(place.x, place.y, place.r, seed);
    const charted = state.status === 'charted';
    const fillAlpha = charted ? 0.18 + 0.32 * (state.pct / 100) : 0.08;

    ctx.save();
    tracePath(ctx, pts);
    ctx.fillStyle = hexToRgba(color, fillAlpha);
    ctx.fill();
    ctx.setLineDash(charted ? [7, 4] : [3, 5]);
    ctx.lineWidth = charted ? 2 : 1.5;
    ctx.strokeStyle = charted ? shade(color, -0.4) : INK_SOFT;
    ctx.stroke();
    ctx.restore();

    drawTerrain(ctx, place, color, seed, !charted);

    if (charted) {
        drawPins(ctx, state, place, seed);
    } else {
        // Named but never walked: the paper is still blank under the fog's edge.
        ctx.save();
        ctx.globalAlpha = 0.6;
        drawFog(ctx, { ...place, r: place.r * 0.8 }, seed);
        ctx.restore();
    }

    const name = plain(region.name).toUpperCase();
    const nameY = place.y + place.r * 0.82 + 4;
    const max = place.island ? 190 : place.r * 2.6;
    label(ctx, name, place.x, nameY, { size: place.island ? 12 : 15, max });

    let sub;
    if (!charted) sub = state.seasonal ? 'IN SEASON — GO LOOK' : 'ROUTE OPEN — UNEXPLORED';
    else if (state.surveyed) sub = 'FULLY SURVEYED';
    else sub = `${state.pct}% CHARTED`;
    if (charted && state.seasonal && !state.inSeason) sub = `${state.surveyed ? 'SURVEYED' : `${state.pct}%`} · OUT OF SEASON`;
    label(ctx, sub, place.x, nameY + (place.island ? 15 : 18), {
        size: place.island ? 10 : 11,
        weight: state.surveyed ? 'bold' : 'normal',
        color: state.surveyed ? SECRET_GOLD : INK_SOFT,
        max,
    });

    if (state.surveyed) {
        // The survey seal: a gold star on the region's shoulder.
        star(ctx, place.x + place.r * 0.8, place.y - place.r * 0.6, 11, SECRET_GOLD, 5);
    }
}

function drawYouAreHere(ctx, place) {
    const x = place.x, y = place.y - 4;
    ctx.save();
    ctx.strokeStyle = PIN_RED;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 10, y - 10);
    ctx.lineTo(x + 10, y + 10);
    ctx.moveTo(x + 10, y - 10);
    ctx.lineTo(x - 10, y + 10);
    ctx.stroke();
    ctx.restore();
}

// ─── Trail, compass, cartouche, legend ───────────────────────────────────────

function drawTrail(ctx, legs) {
    for (const { from, to, walked } of legs) {
        const rand = rng(`${from.x},${from.y}:${to.x},${to.y}`);
        const mx = (from.x + to.x) / 2 + (rand() - 0.5) * 60;
        const my = (from.y + to.y) / 2 + (rand() - 0.5) * 60;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(mx, my, to.x, to.y);
        ctx.setLineDash(walked ? [9, 7] : [2, 8]);
        ctx.lineWidth = walked ? 3 : 2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = walked ? PIN_RED : INK_FAINT;
        ctx.stroke();
        ctx.restore();
    }
}

function drawCompass(ctx, x, y, r) {
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const long = i % 2 === 0;
        const rr = long ? r : r * 0.55;
        const side = 0.18;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        ctx.lineTo(x + Math.cos(a + side * 2) * r * 0.2, y + Math.sin(a + side * 2) * r * 0.2);
        ctx.lineTo(x, y);
        ctx.lineTo(x + Math.cos(a - side * 2) * r * 0.2, y + Math.sin(a - side * 2) * r * 0.2);
        ctx.closePath();
        ctx.fillStyle = i === 0 ? PIN_RED : long ? INK : PARCHMENT_DARK;
        ctx.fill();
        ctx.stroke();
    }
    label(ctx, 'N', x, y - r - 12, { size: 16 });
    ctx.restore();
}

function drawCartouche(ctx, username, level) {
    const x = FRAME + 22, y = FRAME + 20, w = 300, h = 74;
    ctx.save();
    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = 'rgba(236,220,182,0.94)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
    roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 5);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

    label(ctx, "THE EXPLORER'S MAP", x + w / 2, y + 27, { size: 20, halo: false, max: w - 24 });
    const by = username ? `charted by ${username}` : 'charted by an explorer';
    label(ctx, level ? `${by} · Lv ${level}` : by, x + w / 2, y + 52, {
        size: 13, weight: 'normal', color: INK_SOFT, halo: false, max: w - 24,
    });
}

function drawLegend(ctx) {
    const y = CARD_H - FRAME - 22;
    const x0 = CARD_W - FRAME - 470;
    ctx.save();
    roundRect(ctx, x0 - 12, y - 16, 470, 32, 6);
    ctx.fillStyle = 'rgba(236,220,182,0.9)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK_SOFT;
    ctx.stroke();
    ctx.restore();

    let x = x0;
    const item = (draw, text) => {
        draw(x + 6, y);
        label(ctx, text, x + 18, y, { size: 11, weight: 'normal', align: 'left', halo: false });
        ctx.save();
        ctx.font = `normal 11px ${FONT}`;
        x += 18 + ctx.measureText(text).width + 18;
        ctx.restore();
    };
    item((px, py) => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px, py - 7); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 7); ctx.lineTo(px - 5, py);
        ctx.closePath();
        ctx.fillStyle = PIN_RED; ctx.fill();
        ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
    }, 'LANDMARK');
    item((px, py) => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px, py - 7); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 7); ctx.lineTo(px - 5, py);
        ctx.closePath();
        ctx.setLineDash([2, 2]); ctx.strokeStyle = INK_SOFT; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.restore();
    }, 'UNFOUND');
    item((px, py) => star(ctx, px, py, 6, SECRET_GOLD), 'SECRET');
    item((px, py) => {
        ctx.save();
        ctx.strokeStyle = PIN_RED; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px - 5, py - 5); ctx.lineTo(px + 5, py + 5);
        ctx.moveTo(px + 5, py - 5); ctx.lineTo(px - 5, py + 5);
        ctx.stroke();
        ctx.restore();
    }, 'YOU ARE HERE');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Gives every visible region a place: its own, or the next spare slot. */
function placeRegions(states) {
    let spare = 0;
    return states.map(state => {
        const own = LAYOUT[state.region.id];
        const place = own ?? { ...(SPARE_SLOTS[spare++ % SPARE_SLOTS.length]), terrain: 'dunes', island: true };
        return { state, place };
    });
}

/**
 * Draws the map.
 *
 * @param {object} o
 * @param {Array} o.states     exploreService.mapRegionStates(user, guildSettings)
 * @param {string} [o.username]
 * @param {number} [o.level]   Explorer level, for the cartouche
 * @returns {Promise<Buffer>}  PNG
 */
async function createExploreMapCard({ states, username, level }) {
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const placed = placeRegions(states ?? []);

    paintParchment(ctx);
    paintLand(ctx, roughen(CONTINENT, 'continent'), 'continent');
    for (const { place } of placed) {
        if (!place.island) continue;
        paintLand(ctx, roughen(blobPoints(place.x, place.y, place.r * 1.25, `${place.x}:${place.y}`, 10, 0.3), `${place.x}:${place.y}`, 8, 3), `${place.x}:${place.y}`);
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
    drawTrail(ctx, legs);

    for (const { state, place } of placed) drawRegion(ctx, state, place);
    const here = placed.find(p => p.state.active && p.state.status !== 'locked');
    if (here) drawYouAreHere(ctx, here.place);

    drawCompass(ctx, CARD_W - FRAME - 62, 410, 34);
    paintVignette(ctx);
    drawCartouche(ctx, plain(username), level);
    drawLegend(ctx);
    paintFrame(ctx);

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
