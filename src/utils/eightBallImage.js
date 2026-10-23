'use strict';

/**
 * Draws the magic 8-ball: a still of the answer surfacing in its window, and a
 * looping clip of the ball being shaken while the answer is on its way.
 *
 * Both are full scenes — the ball resting under a soft light on a dark backdrop
 * — rather than a cut-out ball on a transparent square. The command shows them
 * as the message's hero image, and a scene reads the same on a dark or a light
 * Discord theme, where a transparent PNG would take on whatever sat behind it
 * (and a GIF, with one-bit transparency, would fringe its edge). The still and
 * the clip share an aspect ratio, so swapping one for the other never changes
 * the height of the message.
 *
 * The die is the toy's own blue whatever the answer: the verdict is the reveal,
 * and colouring the die by outlook gave it away before the words were read. The
 * message's accent stripe carries the outlook instead.
 *
 * Everything is cached. There are twenty answers per language and one shake
 * clip, so each is drawn once per process and served from memory after that.
 */

const { createCanvas } = require('canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { ensureFontsRegistered } = require('./registerFonts');

ensureFontsRegistered();

const FONT = '"DejaVu Sans"';

// ── The ball's own geometry ──────────────────────────────────────────────────
//
// Laid out in a 400px square of "ball space" and scaled into the scene, so the
// layout maths below stays in round numbers whatever size the scene is drawn.

const SIZE   = 400;
const CENTER = SIZE / 2;
const BALL_R = 192;

const WINDOW_R = 134;

// The die face is an equilateral triangle inscribed in a circle a little inside
// the window, so its corners sit in the liquid rather than poking past the
// window's rim.
const DIE_R     = 128;
const APEX_Y    = CENTER - DIE_R;
const BASE_Y    = CENTER + DIE_R / 2;
const HALF_BASE = (DIE_R * Math.sqrt(3)) / 2;

// Text is laid inside the triangle, so the usable width grows with depth. Stay
// clear of the edges — the die's own bevel eats into the corners.
const INSET = 0.86;

// A short ladder of sizes rather than every pixel size from 30 down: answers
// land on one of a few deliberate sizes instead of each getting its own, and
// the floor keeps the longest answer legible once the scene is scaled down.
const TEXT_SIZES = [28, 25, 22, 19, 17];

const DIE = { top: '#3656d6', bottom: '#172a86', glow: 'rgba(80, 120, 255, 0.55)' };

// ── The scene ────────────────────────────────────────────────────────────────

const SCENE_W = 560;
const SCENE_H = 400;
const SCENE_SCALE = 0.86;                 // ball space → scene pixels
const BALL_X = SCENE_W / 2;
const BALL_Y = SCENE_H / 2 - 10;

// The clip is drawn smaller than the still to keep the upload light; it keeps
// the still's aspect ratio, which is what Discord sizes the image slot by.
const CLIP_SCALE  = 0.75;
const CLIP_FRAMES = 12;
const CLIP_FRAME_MS = 70;

const stillCache = new Map();
let clipCache = null;

// Deterministic scatter for the stars and bubbles, so every render of the
// scene is the same scene.
function seeded(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

const STARS = (() => {
    const rand = seeded(8);
    return Array.from({ length: 46 }, () => ({
        x: rand() * SCENE_W,
        y: rand() * SCENE_H * 0.8,
        r: 0.4 + rand() * 1.1,
        a: 0.12 + rand() * 0.4,
    }));
})();

const BUBBLES = (() => {
    const rand = seeded(88);
    return Array.from({ length: 9 }, () => ({
        x: (rand() - 0.5) * WINDOW_R * 1.5,
        phase: rand(),
        r: 1.5 + rand() * 3.5,
    }));
})();

function drawBackdrop(ctx) {
    const bg = ctx.createRadialGradient(BALL_X, BALL_Y - 30, 20, BALL_X, BALL_Y, SCENE_W * 0.7);
    bg.addColorStop(0,    '#2a1f52');
    bg.addColorStop(0.45, '#130f29');
    bg.addColorStop(1,    '#06050c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);

    for (const star of STARS) {
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(210, 200, 255, ${star.a})`;
        ctx.fill();
    }
}

// The ball's contact shadow. It follows the ball sideways while it is being
// shaken, and tightens as the ball lifts.
function drawShadow(ctx, dx = 0, lift = 0) {
    const y = BALL_Y + BALL_R * SCENE_SCALE + 6;
    const w = BALL_R * SCENE_SCALE * (0.82 - lift * 0.004);
    const shadow = ctx.createRadialGradient(BALL_X + dx, y, 4, BALL_X + dx, y, w);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.6)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.save();
    ctx.translate(BALL_X + dx, y);
    ctx.scale(1, 0.16);
    ctx.translate(-(BALL_X + dx), -y);
    ctx.beginPath();
    ctx.arc(BALL_X + dx, y, w, 0, Math.PI * 2);
    ctx.fillStyle = shadow;
    ctx.fill();
    ctx.restore();
}

// ── The ball ─────────────────────────────────────────────────────────────────

function drawBall(ctx) {
    // The sphere: lit from the upper left, falling away to near-black.
    const body = ctx.createRadialGradient(
        CENTER - 70, CENTER - 80, 20,
        CENTER, CENTER, BALL_R,
    );
    body.addColorStop(0,    '#4a4a52');
    body.addColorStop(0.45, '#17171c');
    body.addColorStop(1,    '#040406');

    ctx.beginPath();
    ctx.arc(CENTER, CENTER, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    // Rim light from the backdrop along the lower right, so the ball's edge
    // holds against the dark behind it.
    const rim = ctx.createLinearGradient(CENTER - BALL_R, CENTER - BALL_R, CENTER + BALL_R, CENTER + BALL_R);
    rim.addColorStop(0,   'rgba(255, 255, 255, 0.05)');
    rim.addColorStop(0.6, 'rgba(170, 150, 255, 0.10)');
    rim.addColorStop(1,   'rgba(170, 150, 255, 0.45)');
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, BALL_R - 2, 0, Math.PI * 2);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 4;
    ctx.stroke();

    // The window's raised collar, catching the light on its upper edge.
    const collar = ctx.createLinearGradient(CENTER, CENTER - WINDOW_R - 12, CENTER, CENTER + WINDOW_R + 12);
    collar.addColorStop(0, '#3a3a44');
    collar.addColorStop(1, '#0b0b0f');
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, WINDOW_R + 10, 0, Math.PI * 2);
    ctx.fillStyle = collar;
    ctx.fill();
}

// Gloss goes on last, over the window, the way a real highlight sits on the
// surface in front of everything behind it.
function drawGloss(ctx) {
    ctx.save();
    ctx.translate(CENTER - 88, CENTER - 104);
    ctx.rotate(-0.62);
    const gloss = ctx.createRadialGradient(0, 0, 2, 0, 0, 62);
    gloss.addColorStop(0,    'rgba(255, 255, 255, 0.34)');
    gloss.addColorStop(0.5,  'rgba(255, 255, 255, 0.08)');
    gloss.addColorStop(1,    'rgba(255, 255, 255, 0)');
    ctx.scale(1, 0.55);
    ctx.beginPath();
    ctx.arc(0, 0, 62, 0, Math.PI * 2);
    ctx.fillStyle = gloss;
    ctx.fill();
    ctx.restore();

    // A small hard glint sells the gloss the soft falloff only suggests.
    ctx.save();
    ctx.translate(CENTER - 100, CENTER - 116);
    ctx.rotate(-0.62);
    ctx.scale(1, 0.5);
    const glint = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
    glint.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
    glint.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = glint;
    ctx.fill();
    ctx.restore();
}

// The liquid behind the glass. `murk` (0–1) is how churned up it is.
function drawLiquid(ctx, murk) {
    const fluid = ctx.createRadialGradient(CENTER, CENTER - 30, 8, CENTER, CENTER, WINDOW_R);
    fluid.addColorStop(0, murk ? '#1a2350' : '#111a3a');
    fluid.addColorStop(1, '#03040b');
    ctx.fillStyle = fluid;
    ctx.fillRect(CENTER - WINDOW_R, CENTER - WINDOW_R, WINDOW_R * 2, WINDOW_R * 2);
}

function drawBubbles(ctx, t, alpha) {
    for (const b of BUBBLES) {
        // Each bubble rises through the window once per loop, so the loop joins.
        const p = (b.phase + t) % 1;
        const y = CENTER + WINDOW_R - p * WINDOW_R * 2;
        const wobble = Math.sin((p + b.phase) * Math.PI * 4) * 4;
        ctx.beginPath();
        ctx.arc(CENTER + b.x + wobble, y, b.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(180, 200, 255, ${alpha * (1 - Math.abs(p - 0.5))})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
    }
}

function trianglePath(ctx) {
    ctx.beginPath();
    ctx.moveTo(CENTER, APEX_Y);
    ctx.lineTo(CENTER + HALF_BASE, BASE_Y);
    ctx.lineTo(CENTER - HALF_BASE, BASE_Y);
    ctx.closePath();
}

function drawDie(ctx) {
    ctx.save();
    ctx.shadowColor = DIE.glow;
    ctx.shadowBlur = 18;
    trianglePath(ctx);
    const face = ctx.createLinearGradient(CENTER, APEX_Y, CENTER, BASE_Y);
    face.addColorStop(0, DIE.top);
    face.addColorStop(1, DIE.bottom);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.restore();

    trianglePath(ctx);
    ctx.strokeStyle = 'rgba(160, 185, 255, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// Glass over the liquid: a faint sheen and the rim of the window.
function drawGlass(ctx) {
    withWindowClip(ctx, () => {
        const sheen = ctx.createLinearGradient(CENTER, CENTER - WINDOW_R, CENTER, CENTER);
        sheen.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
        sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = sheen;
        ctx.fillRect(CENTER - WINDOW_R, CENTER - WINDOW_R, WINDOW_R * 2, WINDOW_R);
    });

    ctx.beginPath();
    ctx.arc(CENTER, CENTER, WINDOW_R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();
}

function withWindowClip(ctx, draw) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, WINDOW_R, 0, Math.PI * 2);
    ctx.clip();
    draw();
    ctx.restore();
}

// ── Answer layout ────────────────────────────────────────────────────────────

// Half-width of the triangle at a given height, zero at the apex.
function halfWidthAt(y) {
    if (y <= APEX_Y) return 0;
    if (y >= BASE_Y) return HALF_BASE;
    return HALF_BASE * ((y - APEX_Y) / (BASE_Y - APEX_Y));
}

// Greedy wrap into lines of the given per-line widths. Returns null when the
// text doesn't fit — the caller then tries a smaller font or another line count.
function wrapInto(ctx, text, widths) {
    const words = text.split(' ');
    const lines = [];
    let current = '';

    for (const word of words) {
        const limit = widths[lines.length];
        if (limit === undefined) return null;

        const candidate = current ? `${current} ${word}` : word;
        if (ctx.measureText(candidate).width <= limit) {
            current = candidate;
            continue;
        }
        if (!current) return null; // a single word too wide for its line

        lines.push(current);
        current = word;

        // The word has just started the next line, which is narrower than the
        // one it was rejected from — it has to be measured against that line
        // too, or it silently overhangs the die.
        const next = widths[lines.length];
        if (next === undefined || ctx.measureText(word).width > next) return null;
    }

    if (current) lines.push(current);
    return lines.length === widths.length ? lines : null;
}

// Largest size on the ladder at which the answer fits inside the die face.
function layoutAnswer(ctx, text) {
    for (const size of TEXT_SIZES) {
        ctx.font = `bold ${size}px ${FONT}`;
        const lineHeight = size * 1.15;

        for (let count = 1; count <= 5; count++) {
            // Sit the block low in the triangle, where it is widest.
            const top    = BASE_Y - 12 - count * lineHeight;
            const widths = Array.from({ length: count }, (_, i) =>
                halfWidthAt(top + (i + 1) * lineHeight) * 2 * INSET);

            const lines = wrapInto(ctx, text, widths);
            if (lines) return { lines, size, lineHeight, top };
        }
    }

    // Nothing in the answer tables gets here; a future addition might.
    const size = TEXT_SIZES.at(-1);
    ctx.font = `bold ${size}px ${FONT}`;
    return { lines: [text], size, lineHeight: size * 1.15, top: BASE_Y - 40 };
}

function drawAnswer(ctx, text) {
    const { lines, size, lineHeight, top } = layoutAnswer(ctx, text);

    ctx.font = `bold ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 20, 0.6)';
    ctx.shadowBlur = 3;

    lines.forEach((line, i) => {
        ctx.fillText(line, CENTER, top + (i + 0.5) * lineHeight);
    });

    ctx.shadowBlur = 0;
}

// Moves the drawing context from scene pixels into ball space, offset by the
// shake.
function enterBallSpace(ctx, { dx = 0, dy = 0, rot = 0 } = {}) {
    ctx.translate(BALL_X + dx, BALL_Y + dy);
    ctx.rotate(rot);
    ctx.scale(SCENE_SCALE, SCENE_SCALE);
    ctx.translate(-CENTER, -CENTER);
}

// ── The still ────────────────────────────────────────────────────────────────

/**
 * PNG of the ball with `text` surfaced in its window.
 *
 * `type` is accepted so callers can pass an answer straight through, and so a
 * future treatment by outlook doesn't change the signature; the die itself is
 * the same blue for every answer (see the note at the top of the file).
 *
 * @param {string} text - the answer, e.g. "Signs point to yes."
 * @param {'positive'|'neutral'|'negative'} [_type]
 * @returns {Buffer}
 */
function renderEightBall(text, _type) {
    const hit = stillCache.get(text);
    if (hit) return hit;

    const canvas = createCanvas(SCENE_W, SCENE_H);
    const ctx    = canvas.getContext('2d');

    drawBackdrop(ctx);
    drawShadow(ctx);

    ctx.save();
    enterBallSpace(ctx);
    drawBall(ctx);
    withWindowClip(ctx, () => {
        drawLiquid(ctx, 0);
        drawBubbles(ctx, 0.35, 0.35);
        drawDie(ctx);
        drawAnswer(ctx, text);
    });
    drawGlass(ctx);
    drawGloss(ctx);
    ctx.restore();

    // One of the few canvases in the bot that keeps the synchronous encode
    // (#592). It is bounded in a way the others are not: the cache above is
    // keyed on the answer, and there are twenty answers per language, so this
    // line runs a fixed, small number of times in the life of the process.
    // Making it async would turn every caller into one that awaits a value the
    // cache almost always already has.
    // eslint-disable-next-line no-restricted-syntax -- bounded by the answer tables, see above
    const buffer = canvas.toBuffer('image/png');
    stillCache.set(text, buffer);
    return buffer;
}

// ── The shake clip ───────────────────────────────────────────────────────────

// One frame of the loop, `t` running 0→1. Every motion here is periodic in t so
// the last frame hands back to the first without a jump.
function drawShakeFrame(ctx, t) {
    const turn = t * Math.PI * 2;
    const dx  = Math.sin(turn * 2) * 16;
    const dy  = -Math.abs(Math.sin(turn * 2)) * 8;
    const rot = Math.sin(turn * 2 + 0.6) * 0.07;

    drawBackdrop(ctx);
    drawShadow(ctx, dx, -dy);

    ctx.save();
    enterBallSpace(ctx, { dx, dy, rot });
    drawBall(ctx);
    withWindowClip(ctx, () => {
        drawLiquid(ctx, 1);

        // The die tumbling in the murk, never quite surfacing. A triangle turned
        // through a third of a revolution looks as it started, so one third per
        // loop keeps the loop seamless.
        ctx.save();
        ctx.translate(CENTER, CENTER + 10);
        ctx.rotate(turn / 3);
        ctx.scale(0.8, 0.8);
        ctx.translate(-CENTER, -CENTER);
        ctx.globalAlpha = 0.22 + 0.08 * Math.sin(turn);
        drawDie(ctx);
        ctx.restore();

        // Churned liquid clouding the glass.
        const cloud = ctx.createRadialGradient(CENTER + dx, CENTER, 10, CENTER, CENTER, WINDOW_R);
        cloud.addColorStop(0, 'rgba(40, 55, 120, 0.35)');
        cloud.addColorStop(1, 'rgba(5, 8, 20, 0.2)');
        ctx.fillStyle = cloud;
        ctx.fillRect(CENTER - WINDOW_R, CENTER - WINDOW_R, WINDOW_R * 2, WINDOW_R * 2);

        drawBubbles(ctx, t, 0.7);
        drawBubbles(ctx, (t + 0.5) % 1, 0.45);
    });
    drawGlass(ctx);
    drawGloss(ctx);
    ctx.restore();
}

/**
 * A looping GIF of the ball being shaken, drawn once and cached.
 *
 * @returns {Buffer}
 */
function renderShakeClip() {
    if (clipCache) return clipCache;

    const w = Math.round(SCENE_W * CLIP_SCALE);
    const h = Math.round(SCENE_H * CLIP_SCALE);
    const canvas = createCanvas(w, h);
    const ctx    = canvas.getContext('2d');
    const gif    = GIFEncoder();

    for (let f = 0; f < CLIP_FRAMES; f++) {
        ctx.setTransform(CLIP_SCALE, 0, 0, CLIP_SCALE, 0, 0);
        drawShakeFrame(ctx, f / CLIP_FRAMES);

        // A view over the pixels, not a copy: gifenc type-checks its input,
        // and the canvas's own array can come from another realm (under Jest,
        // for one), which fails that check.
        const { data: pixels } = ctx.getImageData(0, 0, w, h);
        const data     = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        const palette  = quantize(data, 256);
        const index    = applyPalette(data, palette);
        gif.writeFrame(index, w, h, { palette, delay: CLIP_FRAME_MS, repeat: 0 });
    }

    gif.finish();
    clipCache = Buffer.from(gif.bytes());
    return clipCache;
}

module.exports = {
    renderEightBall,
    renderShakeClip,
    CLIP_FRAMES,
    CLIP_FRAME_MS,
    __test__: {
        stillCache, layoutAnswer, wrapInto, halfWidthAt, SIZE, SCENE_W, SCENE_H,
        CLIP_SCALE, TEXT_SIZES, FONT, APEX_Y, BASE_Y, HALF_BASE, WINDOW_R, CENTER,
        drawShakeFrame,
        clearCaches: () => { stillCache.clear(); clipCache = null; },
    },
};
