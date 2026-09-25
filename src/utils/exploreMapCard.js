'use strict';

/**
 * The Explorer's Map, drawn: the picture `/explore map` puts in its embed.
 *
 * A painted world map in the manner of a big open-world game rather than a
 * chart of symbols. The land is a procedural height field — hill-shaded
 * mountain ranges with snow on the peaks, lowland forest canopy, beaches,
 * craters in the Starfall Wastes — cut by rivers that run into lakes and out
 * to a sea that deepens away from the surf line.
 *
 * Over that sits the player's fog of war:
 *   - a region they have walked is shown in full colour;
 *   - one whose route is open but that they have never entered is a sepia
 *     surveyor's sketch with contour lines;
 *   - one still out of reach is under cloud.
 * Found landmarks and secrets are map markers, landmarks still to find are
 * "?" markers, and a pin marks where the player stands. Seasonal regions are
 * islands, and an island whose region is hidden is drawn as open sea.
 *
 * What is visible comes from exploreService.mapRegionStates, the same source
 * the text map reads, so the picture can never show a region the text hides.
 *
 * Cost. The world is the same for every player, so it is generated once per
 * process (on first use) and cached as finished layers: full colour, sketch,
 * cloud and open sea. A render is then one pass that picks between those
 * layers per pixel from a small reveal mask, plus the markers and lettering.
 * Drawing runs on the main thread and the JPEG encode does not (see
 * utils/canvasEncode.js). JPEG, not PNG: a painted map is photographic
 * enough that PNG runs to megabytes.
 *
 * The card-family contract holds (see utils/petStatusCard.js): this is an
 * illustration, not the record. Every number drawn here is also in the embed
 * text, callers give the file alt text, and nothing is drawn as an emoji.
 * Lettering is Cinzel and IM Fell English, bundled in src/fonts and
 * registered by utils/registerFonts.js.
 *
 * @module utils/exploreMapCard
 */

const { createCanvas, createImageData } = require('canvas');
const { encodeCanvas } = require('./canvasEncode');
const { ensureFontsRegistered } = require('./registerFonts');

ensureFontsRegistered();

const CARD_W = 1200;
const CARD_H = 840;
const INNER = 26;                    // lettering stays this far inside the edge
const FILE_EXT = 'jpg';
const JPEG_QUALITY = 0.9;

const TITLE = '"Cinzel", "IM Fell English", "DejaVu Sans"';
const SERIF = '"IM Fell English", "DejaVu Sans"';

const CREAM = '#f6ecd2';
const CREAM_DIM = 'rgba(246,236,210,0.78)';
const GOLD = '#d9b45a';
const GOLD_DEEP = '#a8822e';
const NIGHT = '#17130f';

/**
 * Where each region sits. Core regions share the continent; seasonal ones are
 * islands. `r` is the region's radius on the map; `label` puts its name
 * beside it instead of under it.
 */
const LAYOUT = {
    whispering_forest: { x: 360, y: 510, r: 100 },
    crumbling_ruins:   { x: 545, y: 272, r: 92 },
    crystal_caves:     { x: 830, y: 195, r: 92 },
    sunken_docks:      { x: 890, y: 450, r: 84 },
    starfall_wastes:   { x: 650, y: 555, r: 100 },
    frostveil_pass:    { x: 135, y: 330, r: 56, island: true },
    hollowgrave_lane:  { x: 118, y: 700, r: 50, island: true, label: 'right' },
    arctic_tundra:     { x: 1080, y: 150, r: 48, island: true, label: 'above' },
    velvet_arcade:     { x: 1100, y: 318, r: 44, island: true, label: 'above' },
    scorchglass_shore: { x: 1085, y: 680, r: 52, island: true },
};

// A region added to the data without a place here still gets one: the next
// free offshore slot, drawn as a small island of its own.
const SPARE_SLOTS = [
    { x: 330, y: 780, r: 36, label: 'right' },
    { x: 540, y: 90, r: 36, label: 'right' },
    { x: 1000, y: 780, r: 36 },
];

const CONTINENT = [
    [270, 400], [360, 330], [430, 250], [500, 185], [610, 150], [720, 100],
    [840, 88], [930, 125], [980, 215], [1000, 320], [1005, 420], [990, 520],
    [945, 600], [860, 650], [775, 705], [660, 728], [540, 715], [440, 690],
    [340, 672], [262, 632], [232, 545], [238, 465],
];

// ─── The world's features ────────────────────────────────────────────────────

/** Uplift: [x, y, spread, height]. The Crystal Caves are the high country. */
const MOUNTAINS = [
    [830, 185, 95, 0.95], [700, 150, 60, 0.45], [935, 235, 55, 0.55], [965, 335, 45, 0.35],
    [545, 245, 72, 0.3], [300, 385, 45, 0.18],
    [135, 330, 62, 0.42], [1080, 150, 56, 0.38], [1100, 318, 40, 0.12],
];

/** Basins carved below the waterline: [x, y, spread, depth]. */
const LAKES = [[738, 418, 36, 0.5], [298, 478, 23, 0.42], [765, 252, 15, 1.25]];

/** Craters in the Starfall Wastes: [x, y, radius]. */
const CRATERS = [[622, 562, 38], [704, 604, 22], [594, 616, 16], [692, 518, 17]];

/** Rivers, source to mouth, as control points; they widen downstream. */
const RIVERS = [
    [[792, 150], [772, 212], [748, 280], [754, 342], [738, 398]],
    [[762, 444], [792, 500], [812, 560], [852, 612], [900, 648]],
    [[522, 214], [482, 292], [432, 360], [378, 420], [318, 466]],
    [[283, 494], [262, 538], [232, 562], [195, 575]],
    [[852, 158], [874, 124], [886, 98]],
];

/** Each region's ground: colour, canopy (0–1) and how low its snowline sits (0–1). */
const BIOMES = {
    whispering_forest: { color: [74, 120, 60], canopy: 1 },
    crumbling_ruins:   { color: [170, 152, 96], canopy: 0.1 },
    crystal_caves:     { color: [118, 110, 128], canopy: 0 },
    sunken_docks:      { color: [96, 140, 92], canopy: 0.35 },
    starfall_wastes:   { color: [172, 128, 118], canopy: 0 },
    frostveil_pass:    { color: [222, 230, 238], canopy: 0.15, snow: 1 },
    arctic_tundra:     { color: [214, 226, 236], canopy: 0, snow: 1 },
    hollowgrave_lane:  { color: [150, 86, 48], canopy: 1 },
    scorchglass_shore: { color: [226, 196, 128], canopy: 0 },
    velvet_arcade:     { color: [218, 150, 182], canopy: 0.2 },
};
const GRASS = [122, 150, 80];
const SAND = [224, 206, 152];
const ROCK = [130, 120, 110];
const SNOW = [246, 247, 250];

// ─── Seeded randomness and noise ─────────────────────────────────────────────

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

// Value noise on a seeded 256² lattice: cheap, smooth, and identical every run.
const LATTICE = (() => {
    const rand = rng('explorer-map-world');
    const values = new Float32Array(256 * 256);
    for (let i = 0; i < values.length; i++) values[i] = rand();
    return values;
})();

function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = xi & 255, y0 = yi & 255, x1 = (x0 + 1) & 255, y1 = (y0 + 1) & 255;
    const a = LATTICE[(y0 << 8) | x0], b = LATTICE[(y0 << 8) | x1];
    const c = LATTICE[(y1 << 8) | x0], d = LATTICE[(y1 << 8) | x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, octaves = 5) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * noise(x * freq + i * 17.3, y * freq - i * 9.1);
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    return sum / norm;
}

/** Ridged noise: sharp crests, for mountain ranges. */
function ridged(x, y, octaves = 4) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
        const n = 1 - Math.abs(noise(x * freq + i * 31.7, y * freq + i * 4.2) * 2 - 1);
        sum += amp * n * n;
        norm += amp;
        amp *= 0.5;
        freq *= 2.1;
    }
    return sum / norm;
}

const EXP_CUT_22 = Math.exp(-2.2 * 2.2);
const EXP_CUT_9 = Math.exp(-9);
const EXP_CUT_6 = Math.exp(-6);

const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strips emoji, the joiners around them and Discord formatting, which a canvas cannot draw. */
function plain(str) {
    return String(str ?? '')
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu, '')
        .replace(/[*_~`|]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Traces a smooth closed curve through `pts`. */
function tracePath(ctx, pts, scale = 1) {
    ctx.beginPath();
    const mid = (p, q) => [((p[0] + q[0]) / 2) * scale, ((p[1] + q[1]) / 2) * scale];
    const start = mid(pts[pts.length - 1], pts[0]);
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < pts.length; i++) {
        const m = mid(pts[i], pts[(i + 1) % pts.length]);
        ctx.quadraticCurveTo(pts[i][0] * scale, pts[i][1] * scale, m[0], m[1]);
    }
    ctx.closePath();
}

function blobPoints(cx, cy, r, seed, n = 16, wobble = 0.3) {
    const rand = rng(seed);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (1 - wobble / 2 + rand() * wobble);
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.82]);
    }
    return pts;
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

/** Catmull-Rom through `pts`, sampled into a dense polyline. */
function spline(pts, steps = 12) {
    const out = [];
    const p = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
    for (let i = 0; i < pts.length - 1; i++) {
        const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
        for (let s = 0; s < steps; s++) {
            const t = s / steps, t2 = t * t, t3 = t2 * t;
            out.push([0, 1].map(k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t
                + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
        }
    }
    out.push(pts[pts.length - 1]);
    return out;
}

/** Truncates `str` with an ellipsis to fit `max` in the current font. */
function fitText(ctx, str, max, spacing = 0) {
    const width = s => ctx.measureText(s).width + spacing * Math.max(0, [...s].length - 1);
    if (width(str) <= max) return str;
    while (str.length > 1 && width(`${str}…`) > max) str = str.slice(0, -1);
    return `${str.trimEnd()}…`;
}

/**
 * Game-map lettering: optional letter-spacing, on a feathered dark backing so
 * it reads over any terrain. Returns the drawn span.
 */
function letter(ctx, str, x, y, {
    font, color = CREAM, spacing = 0, max = 420, backing = 0.42, align = 'center',
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
    cx = Math.max(INNER + 8, Math.min(cx, CARD_W - INNER - 8 - total));

    if (backing > 0) {
        // Stacked translucent plates make a soft shadow; a stroked or blurred
        // glyph halo costs node-canvas many times more.
        const size = Number(/(\d+)px/.exec(font)?.[1]) || 20;
        for (const [grow, alpha] of [[16, 0.35], [10, 0.45], [5, 0.6]]) {
            roundRect(ctx, cx - grow, y - size * 0.5 - grow * 0.5, total + grow * 2, size + grow, size * 0.45 + grow * 0.5);
            ctx.fillStyle = `rgba(14,11,8,${(backing * alpha).toFixed(3)})`;
            ctx.fill();
        }
    }
    ctx.fillStyle = color;
    let px = cx;
    chars.forEach((c, i) => { ctx.fillText(c, px, y); px += widths[i] + spacing; });
    ctx.restore();
    return { left: cx, right: cx + total };
}

// ─── The world (built once) ──────────────────────────────────────────────────

/**
 * Signed distance to the coast (positive on land), from a quarter-resolution
 * mask and a two-pass chamfer transform, upsampled on read.
 */
function distanceField(drawShapes) {
    const S = 4;
    const w = Math.ceil(CARD_W / S), h = Math.ceil(CARD_H / S);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    drawShapes(ctx, 1 / S);
    const px = ctx.getImageData(0, 0, w, h).data;

    const chamfer = inside => {
        const INF = 1e6;
        const d = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) d[i] = (px[i * 4] > 127) === inside ? INF : 0;
        const a = 1, b = Math.SQRT2;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (x > 0) d[i] = Math.min(d[i], d[i - 1] + a);
                if (y > 0) {
                    d[i] = Math.min(d[i], d[i - w] + a);
                    if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + b);
                    if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + b);
                }
            }
        }
        for (let y = h - 1; y >= 0; y--) {
            for (let x = w - 1; x >= 0; x--) {
                const i = y * w + x;
                if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + a);
                if (y < h - 1) {
                    d[i] = Math.min(d[i], d[i + w] + a);
                    if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + b);
                    if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + b);
                }
            }
        }
        return d;
    };
    const din = chamfer(true), dout = chamfer(false);
    const sd = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) sd[i] = (din[i] > 0 ? din[i] - 0.5 : 0.5 - dout[i]) * S;

    return (x, y) => {
        const fx = Math.min(w - 1.001, Math.max(0, x / S - 0.5));
        const fy = Math.min(h - 1.001, Math.max(0, y / S - 0.5));
        const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
        const i = y0 * w + x0;
        return mix(mix(sd[i], sd[i + 1], tx), mix(sd[i + w], sd[i + w + 1], tx), ty);
    };
}

const islandShape = place => blobPoints(place.x, place.y, place.r * 1.3, `${place.x}:${place.y}`, 12, 0.35);
const ISLANDS = Object.entries(LAYOUT).filter(([, p]) => p.island);

/** Fallen-star fragments glowing in the Starfall craters. */
function paintStarfall(ctx) {
    const rand = rng('starfall');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [cx, cy, rc] of CRATERS) {
        const shards = 2 + Math.round(rc / 6);
        for (let k = 0; k < shards; k++) {
            const a = rand() * Math.PI * 2, d = rand() * rc * 0.5;
            const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.8;
            const size = 2.5 + rand() * 2.5;
            const g = ctx.createRadialGradient(x, y, 0, x, y, size * 2.2);
            g.addColorStop(0, 'rgba(225,245,255,0.9)');
            g.addColorStop(0.35, 'rgba(140,200,255,0.45)');
            g.addColorStop(1, 'rgba(120,180,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - size * 2.2, y - size * 2.2, size * 4.4, size * 4.4);
        }
    }
    ctx.restore();
}

/** Paints a river onto a layer: a dark bank under the water, widening downstream. */
function paintRiver(ctx, points, water, bank, from, to) {
    const path = spline(points);
    const rand = rng(`river:${points[0]}`);
    const meander = path.map(([x, y], i) => {
        const k = Math.sin(i * 0.55 + rand() * 0.4) * 2.2;
        return [x + k, y + k * 0.6];
    });
    for (const [color, extra] of [[bank, 2.2], [water, 0]]) {
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 1; i < meander.length; i++) {
            ctx.lineWidth = mix(from, to, i / meander.length) + extra;
            ctx.beginPath();
            ctx.moveTo(...meander[i - 1]);
            ctx.lineTo(...meander[i]);
            ctx.stroke();
        }
    }
}

/** A smooth function sampled on a coarse grid and read back bilinearly. */
function coarseField(S, fn) {
    const w = Math.ceil(CARD_W / S) + 1, h = Math.ceil(CARD_H / S) + 1;
    const grid = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y * w + x] = fn(x * S, y * S);
    return (x, y) => {
        const fx = x / S, fy = y / S;
        const x0 = Math.min(w - 2, fx | 0), y0 = Math.min(h - 2, fy | 0), tx = fx - x0, ty = fy - y0;
        const i = y0 * w + x0;
        return mix(mix(grid[i], grid[i + 1], tx), mix(grid[i + w], grid[i + w + 1], tx), ty);
    };
}

// The world takes a couple of seconds of arithmetic to generate, so it is
// built in slices that hand the event loop back between them: a gateway
// heartbeat is never stuck behind it.
const ROWS_PER_SLICE = 8;
const COMPOSITE_ROWS_PER_SLICE = 140;
const nextTick = () => new Promise(resolve => setImmediate(resolve));

let world = null;
let worldPromise = null;

/** True once the world is generated and a render will not wait on it. */
const isWorldReady = () => world !== null;

/**
 * Generates the world once: height, relief shading, water and ground cover,
 * frozen into the colour, sketch, cloud and open-sea layers the renders pick
 * between. Idempotent; the first call starts the work and every call shares
 * it. The explore command starts it when it loads, so it is normally ready
 * before anyone asks for a map.
 *
 * @returns {Promise<object>}
 */
function buildWorld() {
    if (!worldPromise) {
        worldPromise = generateWorld().catch(err => {
            worldPromise = null;
            throw err;
        });
    }
    return worldPromise;
}

async function generateWorld() {
    const W = CARD_W, H = CARD_H, N = W * H;

    const continentOnly = distanceField((ctx, s) => { tracePath(ctx, CONTINENT, s); ctx.fill(); });
    await nextTick();
    const islandsOnly = distanceField((ctx, s) => {
        for (const [, p] of ISLANDS) { tracePath(ctx, islandShape(p), s); ctx.fill(); }
    });
    await nextTick();
    // Slow-varying noise is sampled at quarter or half resolution and read back smoothly.
    const cloudField = coarseField(4, (x, y) => fbm(x * 0.0055 + 3.1, y * 0.009 - 1.7, 5));
    const cloudLight = coarseField(4, (x, y) => fbm(x * 0.0055 + 3.1 - 0.03, y * 0.009 - 1.7 - 0.05, 5));
    await nextTick();
    const seaField = coarseField(2, (x, y) => fbm(x * 0.01, y * 0.01, 3));
    await nextTick();
    const edgeField = coarseField(2, (x, y) => fbm(x * 0.018, y * 0.018, 3) - 0.5);

    const regionIds = Object.keys(LAYOUT);
    const elev = new Float32Array(N);
    const coast = new Float32Array(N);      // warped signed distance to any coast
    const coastC = new Float32Array(N);     // the same, continent only
    const coastI = new Float32Array(N);     // the same, islands only
    const island = new Uint8Array(N);       // 1 + island index, or 0
    const islandBlend = new Float32Array(N);
    const biomeMix = new Float32Array(N * 5); // r, g, b, canopy, snow
    const scorched = new Float32Array(N);   // burnt ground in and around the craters

    for (let y = 0; y < H; y++) {
        if (y % ROWS_PER_SLICE === 0) await nextTick();
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const warp = (fbm(x * 0.011, y * 0.011, 4) - 0.5) * 46 + (fbm(x * 0.045, y * 0.045, 2) - 0.5) * 12;
            const sdC = continentOnly(x, y) + warp, sdI = islandsOnly(x, y) + warp * 0.6;
            const sd = Math.max(sdC, sdI);
            coast[i] = sd;
            coastC[i] = sdC;
            coastI[i] = sdI;

            let near = 0, best = 0;
            for (let k = 0; k < ISLANDS.length; k++) {
                const p = ISLANDS[k][1];
                const d = Math.hypot(x - p.x, (y - p.y) / 0.85) / p.r;
                const b = 1 - smoothstep(2.25, 2.6, d);
                if (b > best) { best = b; near = k + 1; }
            }
            island[i] = near;
            islandBlend[i] = best;

            if (sd < -2) continue;

            // Biome: each region's ground, weighted by distance, over grassland.
            let wr = GRASS[0] * 0.3, wg = GRASS[1] * 0.3, wb = GRASS[2] * 0.3;
            let can = 0.12 * 0.3, snow = 0, wsum = 0.3, wastes = 0;
            for (const id of regionIds) {
                const p = LAYOUT[id];
                const d = Math.hypot(x - p.x, y - p.y) / (p.r * 1.15);
                if (d > 2.2) continue;
                const wgt = Math.exp(-d * d) - EXP_CUT_22;
                const bio = BIOMES[id];
                wr += bio.color[0] * wgt; wg += bio.color[1] * wgt; wb += bio.color[2] * wgt;
                can += bio.canopy * wgt; snow += (bio.snow ?? 0) * wgt; wsum += wgt;
                if (id === 'starfall_wastes') wastes = wgt;
            }
            const o = i * 5;
            biomeMix[o] = wr / wsum; biomeMix[o + 1] = wg / wsum; biomeMix[o + 2] = wb / wsum;
            biomeMix[o + 3] = can / wsum; biomeMix[o + 4] = snow / wsum;

            // Elevation: coast ramp, rolling ground, then ranges, craters, lakes.
            const inland = smoothstep(0, 40, sd);
            let e = 0.05 + 0.035 * inland + 0.2 * (fbm(x * 0.005, y * 0.005, 5) - 0.45) * inland
                + 0.05 * (fbm(x * 0.04, y * 0.04, 3) - 0.5);
            let uplift = 0;
            for (const [mx, my, s, hgt] of MOUNTAINS) {
                const d2 = ((x - mx) ** 2 + (y - my) ** 2) / (s * s);
                // Less the value at the cutoff, so the field meets zero with no step:
                // relief shading turns even a tiny step into a drawn line.
                if (d2 < 9) uplift += hgt * (Math.exp(-d2) - EXP_CUT_9);
            }
            if (uplift > 0) e += uplift * (0.25 + 0.95 * ridged(x * 0.017, y * 0.017, 5)) * inland;
            let scorch = 0;
            if (wastes > 0) {
                // Everything here fades in with the Wastes' own weight, so no step.
                const ws = smoothstep(0, 0.35, wastes);
                e = mix(e, 0.13 + 0.06 * fbm(x * 0.02, y * 0.02, 3), wastes * 0.85);
                for (const [cx, cy, rc] of CRATERS) {
                    const d = Math.hypot(x - cx, y - cy) / rc;
                    if (d < 1) {
                        e -= 0.012 * (1 - d * d) * ws;
                        scorch = Math.max(scorch, (1 - d * d) * ws);
                    }
                    e += 0.01 * Math.exp(-(((d - 1) / 0.38) ** 2)) * ws;
                    scorch = Math.max(scorch, 0.5 * ws * Math.exp(-(((d - 1.2) / 0.5) ** 2)));
                }
                e = mix(e, Math.max(e, 0.035), ws);
            }
            scorched[i] = scorch;
            const ragged = (fbm(x * 0.03, y * 0.03, 2) - 0.5) * 0.5;
            for (const [lx, ly, s, depth] of LAKES) {
                const d2 = ((x - lx) ** 2 + (y - ly) ** 2) / (s * s);
                if (d2 < 6) e -= depth * (Math.exp(-d2) - EXP_CUT_6) * (1 + ragged);
            }
            elev[i] = e;
        }
    }

    const full = new Uint8ClampedArray(N * 4);
    const sketch = new Uint8ClampedArray(N * 4);
    const fog = new Uint8ClampedArray(N * 4);
    const openSea = new Uint8ClampedArray(N * 4);
    const land = new Float32Array(N);       // how far a pixel counts as land, for the fog
    const edge = new Float32Array(N);       // noise that rags the fog's edge

    const LX = -0.5, LY = -0.5, LZ = 0.8;     // light from the north-west, 50° up
    const LN = Math.hypot(LX, LY, LZ);
    const relief = 230;

    // Depth: the continent's shelf runs 150px out, an island's a third of that.
    const sea = (i, x, y, depth, out) => {
        const t = Math.pow(smoothstep(0, 150, depth), 0.7);
        const n = (seaField(x, y) - 0.5) * 18;
        let r = mix(98, 24, t) + n, g = mix(174, 66, t) + n, b = mix(172, 96, t) + n * 0.6;
        // Surf on the shore, and a fainter swell line just off it.
        const surf = 1 - smoothstep(0, 5, depth);
        const swell = Math.exp(-(((depth - 13 - n * 0.2) / 2.2) ** 2)) * 0.22;
        const foam = Math.max(surf * 0.75, swell);
        r = mix(r, 236, foam); g = mix(g, 244, foam); b = mix(b, 240, foam);
        const o = i * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    };

    for (let y = 0; y < H; y++) {
        if (y % ROWS_PER_SLICE === 0) await nextTick();
        for (let x = 0; x < W; x++) {
            const i = y * W + x, o = i * 4;
            const sd = coast[i];
            const shelf = Math.max(0, -coastC[i]);
            if (islandBlend[i] > 0) sea(i, x, y, shelf, openSea);
            edge[i] = edgeField(x, y);

            // Cloud for the fog of war, stretched along the wind and lit from the north-west.
            const cl = cloudField(x, y);
            const puff = smoothstep(0.3, 0.7, cl);
            const lift = Math.max(-1, Math.min(1, (cl - cloudLight(x, y)) * 40));
            const fr = mix(118, 236, puff) + lift * 14, fg = mix(126, 234, puff) + lift * 14, fb = mix(146, 230, puff) + lift * 10;
            fog[o] = fr; fog[o + 1] = fg; fog[o + 2] = fb; fog[o + 3] = 255;

            land[i] = smoothstep(-30, 2, sd);

            if (sd < 0) {
                sea(i, x, y, Math.min(shelf, Math.max(0, -coastI[i]) * 3), full);
                sketch[o] = full[o]; sketch[o + 1] = full[o + 1]; sketch[o + 2] = full[o + 2]; sketch[o + 3] = 255;
                continue;
            }

            const e = elev[i];
            const ex = elev[i + (x < W - 1 ? 1 : 0)] - elev[i - (x > 0 ? 1 : 0)];
            const ey = elev[i + (y < H - 1 ? W : 0)] - elev[i - (y > 0 ? W : 0)];
            const nl = Math.hypot(ex * relief, ey * relief, 1);
            const lambert = Math.max(0, (-ex * relief * LX - ey * relief * LY + LZ) / nl) / LN;
            // Flat ground sits at 1; slopes toward the light brighten, away darken.
            let shade = 0.22 + lambert;
            if (e < 0) shade = 1;   // water lies flat

            let r, g, b, snowCover = 0;
            if (e < 0) {
                // Lake: shallows to deep, with a pale shore.
                const t = smoothstep(0, 0.14, -e);
                r = mix(112, 38, t); g = mix(176, 94, t); b = mix(178, 122, t);
                const shore = (1 - smoothstep(0, 0.012, -e)) * 0.6;
                r = mix(r, 220, shore); g = mix(g, 232, shore); b = mix(b, 226, shore);
            } else {
                const bo = i * 5;
                r = biomeMix[bo]; g = biomeMix[bo + 1]; b = biomeMix[bo + 2];
                const canopy = biomeMix[bo + 3], snowy = biomeMix[bo + 4];

                // Beaches along the coast and the lake shores.
                const bch = Math.min(1, (1 - smoothstep(4, 14, sd)) * (1 - smoothstep(0.15, 0.3, e))
                    + (1 - smoothstep(0, 0.035, e)) * 0.7);
                r = mix(r, SAND[0], bch); g = mix(g, SAND[1], bch); b = mix(b, SAND[2], bch);

                // Rock above the treeline, snow on the peaks (lower in the north isles).
                const rock = smoothstep(0.5, 0.68, e) * (1 - snowy * 0.7);
                r = mix(r, ROCK[0], rock); g = mix(g, ROCK[1], rock); b = mix(b, ROCK[2], rock);
                const snowAt = 0.8 - 0.62 * snowy;
                const sn = smoothstep(snowAt, snowAt + 0.1, e + (fbm(x * 0.04, y * 0.04, 2) - 0.5) * 0.12);
                r = mix(r, SNOW[0], sn); g = mix(g, SNOW[1], sn); b = mix(b, SNOW[2], sn);
                snowCover = sn;

                // Forest canopy: clumped crowns, thinning toward clearings and the heights.
                const cover = canopy * (1 - rock) * (1 - bch)
                    * smoothstep(0.35, 0.55, fbm(x * 0.02, y * 0.02, 3) + canopy * 0.25);
                if (cover > 0.02) {
                    const crowns = noise(x * 0.26, y * 0.26) * 0.6 + noise(x * 0.55 + 7, y * 0.55) * 0.4;
                    const k = 1 - cover * (0.32 - crowns * 0.36);
                    r *= k * 0.92; g *= k; b *= k * 0.9;
                }
                const burn = scorched[i];
                if (burn > 0) { r = mix(r, 58, burn * 0.85); g = mix(g, 42, burn * 0.85); b = mix(b, 66, burn * 0.85); }
                const grain = (noise(x * 0.9, y * 0.9) - 0.5) * 12;
                r += grain; g += grain; b += grain;
            }

            // Light, graded the way a painted map is: cool shadows, warm highlights.
            // Snow stays bright in shade, the way it does.
            shade = mix(shade, Math.max(shade, 0.72), snowCover);
            r *= shade; g *= shade; b *= shade;
            const cool = Math.max(0, 0.8 - shade) * 0.55;
            r = mix(r, 52, cool); g = mix(g, 64, cool); b = mix(b, 108, cool);
            const warm = Math.max(0, shade - 1.02) * 0.8;
            r = mix(r, 255, warm * 0.35); g = mix(g, 236, warm * 0.3);
            full[o] = r; full[o + 1] = g; full[o + 2] = b; full[o + 3] = 255;

            // The surveyor's sketch: sepia relief with contour lines.
            const tone = 0.62 + 0.4 * Math.min(1.1, shade);
            let sr = 226 * tone, sg = 208 * tone, sb = 170 * tone;
            if (e < 0) { sr = 170; sg = 186; sb = 182; }
            const c = (Math.max(0, e) * 16) % 1;
            if (e > 0.02 && (c < 0.07 || c > 0.965)) { sr *= 0.62; sg *= 0.58; sb *= 0.52; }
            sketch[o] = sr; sketch[o + 1] = sg; sketch[o + 2] = sb; sketch[o + 3] = 255;
        }
    }

    // Rivers go onto the colour and sketch layers before they are frozen.
    const bake = (data, water, bank, scale, extra) => {
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(createImageData(data, W, H), 0, 0);
        for (const river of RIVERS) paintRiver(ctx, river, water, bank, 1.4 * scale, 5 * scale);
        extra?.(ctx);
        return ctx.getImageData(0, 0, W, H).data;
    };
    await nextTick();
    const fullBaked = bake(full, '#4f98b0', 'rgba(28,58,64,0.55)', 1, paintStarfall);
    await nextTick();
    const sketchBaked = bake(sketch, 'rgba(120,150,150,0.9)', 'rgba(80,60,40,0.6)', 0.7);
    world = { full: fullBaked, sketch: sketchBaked, fog, openSea, land, edge, island, islandBlend };
    return world;
}

// ─── Fog of war (per render) ─────────────────────────────────────────────────

/**
 * A half-resolution mask of what the player has seen: red for walked ground,
 * green for ground they know of. Drawn with 'lighten', so where two regions'
 * reach overlaps each channel keeps the greater.
 */
function revealMask(placed, legs) {
    const S = 2;
    const w = CARD_W / S, h = CARD_H / S;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighten';

    const glow = (x, y, r, rgb) => {
        const g = ctx.createRadialGradient(x / S, y / S, 0, x / S, y / S, r / S);
        g.addColorStop(0, `rgb(${rgb})`);
        g.addColorStop(0.6, `rgb(${rgb})`);
        g.addColorStop(1, 'rgb(0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect((x - r) / S, (y - r) / S, (r * 2) / S, (r * 2) / S);
    };
    // Known ground takes the greater of any overlap; walked ground adds up, so
    // the country between several walked regions clears as well.
    for (const { state, place } of placed) {
        if (state.status !== 'known') continue;
        glow(place.x, place.y, place.r * (place.island ? 1.9 : 2.5), '0,255,0');
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const { state, place } of placed) {
        if (state.status !== 'charted') continue;
        glow(place.x, place.y, place.r * (place.island ? 1.9 : 2.8), '255,255,0');
    }
    // The road between two walked regions is walked ground too.
    ctx.lineCap = 'round';
    for (const { from, to, walked } of legs) {
        if (!walked) continue;
        for (const [width, v] of [[90, 120], [60, 190], [34, 255]]) {
            ctx.strokeStyle = `rgb(${v},${v},0)`;
            ctx.lineWidth = width / S;
            ctx.beginPath();
            ctx.moveTo(from.x / S, from.y / S);
            ctx.lineTo(to.x / S, to.y / S);
            ctx.stroke();
        }
    }
    return { data: ctx.getImageData(0, 0, w, h).data, w, h, S };
}

async function composite(ctx, placed, legs) {
    const wd = await buildWorld();
    const { data: m, w: mw, h: mh, S } = revealMask(placed, legs);
    const hidden = new Uint8Array(ISLANDS.length + 1);
    ISLANDS.forEach(([id], k) => {
        hidden[k + 1] = placed.some(p => p.state.region.id === id) ? 0 : 1;
    });

    const out = createImageData(CARD_W, CARD_H);
    const px = out.data;
    const { full, sketch, fog, openSea, land, edge, island, islandBlend } = wd;

    for (let y = 0; y < CARD_H; y++) {
        // A million pixels is ~100ms of arithmetic: hand the loop back as it goes.
        if (y % COMPOSITE_ROWS_PER_SLICE === 0 && y > 0) await nextTick();
        const fy = Math.min(mh - 1.001, Math.max(0, y / S - 0.5));
        const y0 = fy | 0, ty = fy - y0;
        for (let x = 0; x < CARD_W; x++) {
            const i = y * CARD_W + x, o = i * 4;
            let r = full[o], g = full[o + 1], b = full[o + 2];
            const lw = land[i];
            if (lw > 0) {
                const fx = Math.min(mw - 1.001, Math.max(0, x / S - 0.5));
                const x0 = fx | 0, tx = fx - x0;
                const mi = (y0 * mw + x0) * 4, below = mi + mw * 4;
                const walked = mix(mix(m[mi], m[mi + 4], tx), mix(m[below], m[below + 4], tx), ty) / 255;
                const known = mix(mix(m[mi + 1], m[mi + 5], tx), mix(m[below + 1], m[below + 5], tx), ty) / 255;
                const n = edge[i] * 0.5;
                const seen = smoothstep(0.3, 0.62, Math.max(walked, known) + n);
                const lit = seen > 0 ? Math.min(1, smoothstep(0.3, 0.62, walked + n) / seen) : 0;
                // Sketch toward colour by how walked; cloud toward that by how seen.
                const vr = mix(sketch[o], r, lit), vg = mix(sketch[o + 1], g, lit), vb = mix(sketch[o + 2], b, lit);
                r = mix(r, mix(fog[o], vr, seen), lw);
                g = mix(g, mix(fog[o + 1], vg, seen), lw);
                b = mix(b, mix(fog[o + 2], vb, seen), lw);
            }
            const isl = island[i];
            if (isl && hidden[isl]) {
                const t = islandBlend[i];
                r = mix(r, openSea[o], t); g = mix(g, openSea[o + 1], t); b = mix(b, openSea[o + 2], t);
            }
            px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);
}

// ─── Markers ─────────────────────────────────────────────────────────────────

/**
 * A soft drop shadow as two offset translucent discs. shadowBlur looks the
 * same at this size and costs node-canvas a blur pass per shape.
 */
function dropShadow(ctx, x, y, r) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.arc(x, y + 2.5, r + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y + 2, r + 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function badge(ctx, x, y, r, { ring = GOLD, dim = false } = {}) {
    dropShadow(ctx, x, y, r);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim ? 'rgba(23,19,15,0.6)' : NIGHT;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = ring;
    ctx.stroke();
    ctx.restore();
}

/** A found landmark: a tower on a gold-ringed badge. */
function landmarkMarker(ctx, x, y) {
    badge(ctx, x, y, 13);
    ctx.save();
    ctx.fillStyle = CREAM;
    ctx.fillRect(x - 3.5, y - 4, 7, 10);
    ctx.fillRect(x - 5.5, y - 7, 11, 3.5);
    ctx.fillStyle = NIGHT;
    ctx.fillRect(x - 2.4, y - 7, 1.6, 1.8);
    ctx.fillRect(x + 0.8, y - 7, 1.6, 1.8);
    ctx.fillRect(x - 1.2, y + 1.5, 2.4, 4.5);
    ctx.restore();
}

/** A landmark still to find: the open-world "?". */
function unknownMarker(ctx, x, y) {
    badge(ctx, x, y, 11, { ring: 'rgba(246,236,210,0.55)', dim: true });
    ctx.save();
    ctx.font = `bold 15px ${SERIF}`;
    ctx.fillStyle = CREAM_DIM;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y + 1);
    ctx.restore();
}

function sparkle(ctx, x, y, r, color) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.3;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

/** A found secret: a gold sparkle on a dark badge. */
function secretMarker(ctx, x, y) {
    badge(ctx, x, y, 12, { ring: GOLD_DEEP });
    sparkle(ctx, x, y, 8, GOLD);
}

/** Where the player stands: a glowing pin. */
function playerMarker(ctx, x, y) {
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 0, x, y, 46);
    g.addColorStop(0, 'rgba(255,228,150,0.55)');
    g.addColorStop(1, 'rgba(255,228,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 46, y - 46, 92, 92);
    ctx.beginPath();
    ctx.ellipse(x, y, 20, 8, 0, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,236,180,0.9)';
    ctx.stroke();

    // The pin: a teardrop standing on the ring.
    const top = y - 44;
    dropShadow(ctx, x + 2, top + 16, 15);
    ctx.beginPath();
    ctx.moveTo(x, y - 2);
    ctx.bezierCurveTo(x - 6, y - 16, x - 16, y - 24, x - 16, top + 14);
    ctx.arc(x, top + 14, 16, Math.PI, 0);
    ctx.bezierCurveTo(x + 16, y - 24, x + 6, y - 16, x, y - 2);
    ctx.closePath();
    const pg = ctx.createLinearGradient(x - 16, top, x + 16, y);
    pg.addColorStop(0, '#f8dc86');
    pg.addColorStop(1, '#b8862a');
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = NIGHT;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, top + 14, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = NIGHT;
    ctx.fill();
    ctx.restore();
}

/** Marker spots around a region, clear of its centre where the pin stands. */
function markerSpots(place, count, seed, from = 0.34, to = 0.66) {
    const rand = rng(seed);
    const spots = [];
    for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rand() * 0.5 - Math.PI / 2;
        const d = place.r * (from + rand() * (to - from));
        spots.push([place.x + Math.cos(a) * d, place.y + Math.sin(a) * d * 0.78]);
    }
    return spots;
}

function drawMarkers(ctx, state, place) {
    const [found, total] = state.landmarks;
    const [secrets] = state.secrets;
    const area = { ...place, r: place.island ? place.r * 1.25 : place.r };
    const k = place.island ? 0.8 : 1;
    const at = (x, y, draw) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(k, k);
        draw(ctx, 0, 0);
        ctx.restore();
    };
    markerSpots(area, total, `${state.region.id}:marks`)
        .forEach(([x, y], i) => at(x, y, i < found ? landmarkMarker : unknownMarker));
    markerSpots(area, secrets, `${state.region.id}:secrets`, 0.12, 0.3)
        .forEach(([x, y]) => at(x, y, secretMarker));
}

// ─── Lettering and chrome ────────────────────────────────────────────────────

/** The survey laurel: a gold medallion beside a fully surveyed region's name. */
function laurel(ctx, x, y, r) {
    dropShadow(ctx, x, y, r);
    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    g.addColorStop(0, '#fbe6a2');
    g.addColorStop(1, GOLD_DEEP);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = NIGHT;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    // Leaves up each side, a star between them.
    ctx.fillStyle = NIGHT;
    for (const side of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
            const a = Math.PI / 2 + side * (0.5 + k * 0.55);
            ctx.beginPath();
            ctx.ellipse(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62, r * 0.2, r * 0.09, a + side * 0.9, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    sparkle(ctx, x, y - r * 0.05, r * 0.42, NIGHT);
    ctx.restore();
}

function progressBar(ctx, x, y, w, pct, surveyed) {
    ctx.save();
    roundRect(ctx, x - w / 2 - 2, y - 5, w + 4, 10, 5);
    ctx.fillStyle = 'rgba(14,11,8,0.7)';
    ctx.fill();
    roundRect(ctx, x - w / 2, y - 3, Math.max(6, (w * pct) / 100), 6, 3);
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, surveyed ? '#fbe6a2' : '#e8d9a8');
    g.addColorStop(1, surveyed ? GOLD : '#b9a36a');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
}

function drawLabel(ctx, state, place) {
    const { region } = state;
    const compact = Boolean(place.island);
    const side = place.label === 'right' || place.label === 'left' ? place.label : null;
    const reach = compact ? place.r * 1.3 : place.r;
    const x = side === 'right' ? place.x + reach + 14 : side === 'left' ? place.x - reach - 14 : place.x;
    const align = side === 'right' ? 'left' : side === 'left' ? 'right' : 'center';
    const y = side ? place.y - 14
        : place.label === 'above' ? place.y - reach * 0.8 - (compact ? 46 : 60)
            : place.y + reach * 0.8 + (compact ? 14 : 22);

    if (state.status === 'locked') {
        // Sits a little below the region's centre, clear of neighbours' names.
        letter(ctx, 'UNCHARTED', place.x, place.y + 12, { font: `26px ${TITLE}`, spacing: 3, backing: 0.5 });
        letter(ctx, `reach Explorer Lv ${region.unlockLevel}`, place.x, place.y + 42, {
            font: `italic 23px ${SERIF}`, color: CREAM_DIM, backing: 0.45,
        });
        return;
    }

    const box = letter(ctx, plain(region.name).toUpperCase(), x, y, {
        font: `${compact ? 21 : 28}px ${TITLE}`, spacing: compact ? 1.5 : 2.5, max: compact ? 260 : 440, align,
    });
    const mid = (box.left + box.right) / 2;
    const subY = y + (compact ? 27 : 34);
    const subFont = `italic ${compact ? 19 : 22}px ${SERIF}`;

    if (state.status === 'known') {
        letter(ctx, state.seasonal ? 'in season — unexplored' : 'route open — unexplored', mid, subY, {
            font: subFont, color: CREAM_DIM,
        });
        return;
    }

    // A progress bar and its figure, centred as one row under the name.
    const barW = compact ? 110 : 150;
    const note = state.seasonal && !state.inSeason ? ' · out of season' : '';
    const figure = state.surveyed ? `surveyed${note}` : `${state.pct}%${note}`;
    ctx.save();
    ctx.font = subFont;
    const rowW = barW + 10 + ctx.measureText(figure).width;
    ctx.restore();
    const rowLeft = Math.max(INNER + 12, Math.min(mid - rowW / 2, CARD_W - INNER - 12 - rowW));
    letter(ctx, figure, rowLeft + barW + 10, subY, { font: subFont, align: 'left', color: state.surveyed ? '#f7dd8f' : CREAM });
    progressBar(ctx, rowLeft + barW / 2, subY, barW, state.pct, state.surveyed);

    if (state.surveyed) {
        const r = compact ? 14 : 18;
        const fits = box.right + r * 2 + 12 < CARD_W - INNER;
        laurel(ctx, fits ? box.right + r + 12 : box.left - r - 12, y, r);
    }
}

function drawRoads(ctx, legs) {
    for (const { from, to, walked } of legs) {
        const rand = rng(`${from.x},${from.y}:${to.x},${to.y}`);
        const mx = (from.x + to.x) / 2 + (rand() - 0.5) * 70;
        const my = (from.y + to.y) / 2 + (rand() - 0.5) * 70;
        const trace = () => {
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.quadraticCurveTo(mx, my, to.x, to.y);
        };
        ctx.save();
        ctx.lineCap = 'round';
        if (walked) {
            trace();
            ctx.lineWidth = 7;
            ctx.strokeStyle = 'rgba(40,28,16,0.55)';
            ctx.stroke();
            trace();
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = '#ecd9a6';
            ctx.stroke();
        } else {
            trace();
            ctx.setLineDash([2, 11]);
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = 'rgba(246,236,210,0.7)';
            ctx.stroke();
        }
        ctx.restore();
    }
}

function drawCompass(ctx, x, y, r) {
    dropShadow(ctx, x, y, r);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14,11,8,0.55)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.84, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        const inner = i % 9 === 0 ? r * 0.72 : r * 0.84;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
        ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        ctx.stroke();
    }
    const point = (a, len, width, left, right) => {
        const tip = [x + Math.cos(a) * len, y + Math.sin(a) * len];
        const l = [x + Math.cos(a - Math.PI / 2) * width, y + Math.sin(a - Math.PI / 2) * width];
        const rr = [x + Math.cos(a + Math.PI / 2) * width, y + Math.sin(a + Math.PI / 2) * width];
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(...l); ctx.lineTo(...tip); ctx.closePath();
        ctx.fillStyle = left; ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(...rr); ctx.lineTo(...tip); ctx.closePath();
        ctx.fillStyle = right; ctx.fill();
    };
    for (let i = 0; i < 4; i++) point((i / 4) * Math.PI * 2 - Math.PI / 4, r * 0.55, r * 0.09, '#e9d49a', GOLD_DEEP);
    for (let i = 0; i < 4; i++) {
        const north = i === 0;
        point((i / 4) * Math.PI * 2 - Math.PI / 2, r * 0.8, r * 0.14, north ? '#e8574a' : CREAM, north ? '#9c2a22' : '#b9a36a');
    }
    ctx.restore();
    letter(ctx, 'N', x, y - r - 18, { font: `26px ${TITLE}`, backing: 0 });
}

function drawTitle(ctx, username, level) {
    const x = INNER, y = INNER, w = 470, h = 92;
    ctx.save();
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(14,11,8,0.82)');
    g.addColorStop(0.75, 'rgba(14,11,8,0.6)');
    g.addColorStop(1, 'rgba(14,11,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    const rule = ctx.createLinearGradient(x, 0, x + w, 0);
    rule.addColorStop(0, GOLD);
    rule.addColorStop(1, 'rgba(217,180,90,0)');
    ctx.fillStyle = rule;
    ctx.fillRect(x, y, w, 2);
    ctx.fillRect(x, y + h - 2, w, 2);
    ctx.restore();

    letter(ctx, "THE EXPLORER'S MAP", x + 22, y + 34, { font: `33px ${TITLE}`, spacing: 2.5, align: 'left', backing: 0, color: '#f7e3a8' });
    const who = username || 'an explorer';
    letter(ctx, level ? `${who}  ·  Explorer Lv ${level}` : who, x + 24, y + 68, {
        font: `italic 24px ${SERIF}`, align: 'left', backing: 0, max: w - 40,
    });
}

function drawLegend(ctx) {
    const y = CARD_H - INNER - 22;
    let x = INNER + 16;
    ctx.save();
    const g = ctx.createLinearGradient(INNER, 0, INNER + 640, 0);
    g.addColorStop(0, 'rgba(14,11,8,0.72)');
    g.addColorStop(0.8, 'rgba(14,11,8,0.5)');
    g.addColorStop(1, 'rgba(14,11,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(INNER, y - 22, 640, 44);
    ctx.restore();
    const item = (draw, text) => {
        draw(x + 12, y);
        const box = letter(ctx, text, x + 32, y, { font: `italic 21px ${SERIF}`, align: 'left', backing: 0 });
        x = box.right + 24;
    };
    item((px, py) => landmarkMarker(ctx, px, py), 'landmark');
    item((px, py) => unknownMarker(ctx, px, py), 'undiscovered');
    item((px, py) => secretMarker(ctx, px, py), 'secret');
    item((px, py) => laurel(ctx, px, py, 12), 'fully surveyed');
}

/** Vignette and a thin gilt frame, drawn once. */
let chrome = null;
function getChrome() {
    if (chrome) return chrome;
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const v = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, CARD_H * 0.5, CARD_W / 2, CARD_H / 2, CARD_W * 0.72);
    v.addColorStop(0, 'rgba(8,6,4,0)');
    v.addColorStop(1, 'rgba(8,6,4,0.32)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    ctx.strokeStyle = 'rgba(217,180,90,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, CARD_W - 20, CARD_H - 20);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(217,180,90,0.5)';
    ctx.strokeRect(16, 16, CARD_W - 32, CARD_H - 32);
    // A diamond at each corner where the rules meet.
    ctx.fillStyle = GOLD;
    for (const [cx, cy] of [[13, 13], [CARD_W - 13, 13], [13, CARD_H - 13], [CARD_W - 13, CARD_H - 13]]) {
        ctx.beginPath();
        ctx.moveTo(cx, cy - 8); ctx.lineTo(cx + 8, cy); ctx.lineTo(cx, cy + 8); ctx.lineTo(cx - 8, cy);
        ctx.closePath();
        ctx.fill();
    }
    chrome = canvas;
    return chrome;
}

/** A region with no baked island of its own gets a simple one, drawn live. */
function drawSpareIsland(ctx, place) {
    const pts = blobPoints(place.x, place.y, place.r * 1.2, `${place.x}:${place.y}`);
    ctx.save();
    tracePath(ctx, pts);
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(236,244,240,0.6)';
    ctx.stroke();
    const g = ctx.createRadialGradient(place.x - place.r * 0.3, place.y - place.r * 0.3, 2, place.x, place.y, place.r * 1.2);
    g.addColorStop(0, '#9fbf78');
    g.addColorStop(0.8, '#6f9150');
    g.addColorStop(1, '#d9c68f');
    ctx.fillStyle = g;
    ctx.fill();
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
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext('2d');
    const placed = placeRegions(states ?? []);

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

    await composite(ctx, placed, legs);
    for (const { place } of placed) if (place.spare) drawSpareIsland(ctx, place);
    drawRoads(ctx, legs);
    for (const { state, place } of placed) if (state.status === 'charted') drawMarkers(ctx, state, place);
    const here = placed.find(p => p.state.active && p.state.status !== 'locked');
    if (here) playerMarker(ctx, here.place.x, here.place.y);

    ctx.drawImage(getChrome(), 0, 0);
    // Uncharted first, so a fog label never sits over a neighbour's name.
    const order = [...placed].sort((a, b) => (a.state.status === 'locked' ? 0 : 1) - (b.state.status === 'locked' ? 0 : 1));
    for (const { state, place } of order) drawLabel(ctx, state, place);

    letter(ctx, 'The Unquiet Sea', 700, 790, { font: `italic 28px ${SERIF}`, color: 'rgba(230,240,238,0.8)', spacing: 3, backing: 0 });
    drawCompass(ctx, 1100, 505, 46);
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
    isWorldReady,
    CARD_W,
    CARD_H,
    FILE_EXT,
    LAYOUT,
    __test__: { plain, placeRegions, hashSeed },
};
