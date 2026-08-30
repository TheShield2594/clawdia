'use strict';

/**
 * Draws the answer inside a magic 8-ball's window.
 *
 * The command previously showed a static 72px twemoji next to the text, which
 * said "8-ball" but never said anything about the answer. Rendering the ball
 * with the reply in its window is the whole visual — the die face is tinted by
 * outlook, so the verdict reads before the text does.
 *
 * There are only twenty answers, so every render is cached: the first shake of
 * each one pays for the canvas, every shake after it is a map lookup.
 */

const { createCanvas } = require('canvas');
const { ensureFontsRegistered } = require('./registerFonts');

ensureFontsRegistered();

const FONT = '"DejaVu Sans"';

const SIZE   = 400;
const CENTER = SIZE / 2;
const BALL_R = 192;

// The window, and the die floating in it.
const WINDOW_R  = 118;
const APEX_Y    = CENTER - 92;
const BASE_Y    = CENTER + 74;
const HALF_BASE = 98;

// Text is laid inside the triangle, so the usable width grows with depth. Stay
// clear of the edges — the die's own bevel eats into the corners.
const INSET = 0.84;

const TINTS = {
    positive: { die: '#1c7a4a', edge: '#25a163' },
    neutral:  { die: '#8a5b12', edge: '#c07f1c' },
    negative: { die: '#8f2420', edge: '#c1332c' },
};

const cache = new Map();

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

// Largest font size at which the answer fits inside the die face.
function layoutAnswer(ctx, text) {
    for (let size = 30; size >= 11; size--) {
        ctx.font = `bold ${size}px ${FONT}`;
        const lineHeight = size * 1.2;

        for (let count = 1; count <= 4; count++) {
            // Sit the block low in the triangle, where it is widest.
            const top    = BASE_Y - 26 - count * lineHeight;
            const widths = Array.from({ length: count }, (_, i) =>
                halfWidthAt(top + (i + 1) * lineHeight) * 2 * INSET);

            const lines = wrapInto(ctx, text, widths);
            if (lines) return { lines, size, lineHeight, top };
        }
    }

    // Nothing in the answer table gets here; a future addition might.
    ctx.font = `bold 11px ${FONT}`;
    return { lines: [text], size: 11, lineHeight: 13, top: BASE_Y - 40 };
}

function drawBall(ctx) {
    // The sphere: lit from the upper left, falling away to near-black.
    const body = ctx.createRadialGradient(
        CENTER - 70, CENTER - 80, 20,
        CENTER, CENTER, BALL_R,
    );
    body.addColorStop(0,    '#4a4a4a');
    body.addColorStop(0.45, '#181818');
    body.addColorStop(1,    '#050505');

    ctx.beginPath();
    ctx.arc(CENTER, CENTER, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    // A rim of reflected light along the lower right stops the ball from
    // dissolving into a dark message background.
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, BALL_R - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Specular highlight: a fast falloff, otherwise the gradient fills its whole
    // ellipse with mid-grey and reads as a smudge rather than gloss.
    const gloss = ctx.createRadialGradient(
        CENTER - 82, CENTER - 100, 2,
        CENTER - 82, CENTER - 100, 58,
    );
    gloss.addColorStop(0,    'rgba(255, 255, 255, 0.40)');
    gloss.addColorStop(0.35, 'rgba(255, 255, 255, 0.10)');
    gloss.addColorStop(1,    'rgba(255, 255, 255, 0)');
    ctx.beginPath();
    ctx.ellipse(CENTER - 82, CENTER - 100, 54, 34, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = gloss;
    ctx.fill();

    // A small hard glint sells the gloss the soft falloff only suggests.
    const glint = ctx.createRadialGradient(
        CENTER - 92, CENTER - 112, 0,
        CENTER - 92, CENTER - 112, 15,
    );
    glint.addColorStop(0, 'rgba(255, 255, 255, 0.72)');
    glint.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.beginPath();
    ctx.ellipse(CENTER - 92, CENTER - 112, 15, 9, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = glint;
    ctx.fill();
}

function drawWindow(ctx, tint) {
    // The liquid behind the die.
    const fluid = ctx.createRadialGradient(
        CENTER, CENTER - 30, 10,
        CENTER, CENTER, WINDOW_R,
    );
    fluid.addColorStop(0, '#111a2e');
    fluid.addColorStop(1, '#05070d');

    ctx.beginPath();
    ctx.arc(CENTER, CENTER, WINDOW_R, 0, Math.PI * 2);
    ctx.fillStyle = fluid;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // The die face.
    ctx.beginPath();
    ctx.moveTo(CENTER, APEX_Y);
    ctx.lineTo(CENTER + HALF_BASE, BASE_Y);
    ctx.lineTo(CENTER - HALF_BASE, BASE_Y);
    ctx.closePath();

    const face = ctx.createLinearGradient(CENTER, APEX_Y, CENTER, BASE_Y);
    face.addColorStop(0, tint.edge);
    face.addColorStop(1, tint.die);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 2;
    ctx.stroke();
}

function drawAnswer(ctx, text) {
    const { lines, size, lineHeight, top } = layoutAnswer(ctx, text);

    ctx.font = `bold ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 4;

    lines.forEach((line, i) => {
        ctx.fillText(line, CENTER, top + (i + 0.5) * lineHeight);
    });

    ctx.shadowBlur = 0;
}

/**
 * PNG of the ball showing `text`, tinted for `type`.
 *
 * @param {string} text - the answer, e.g. "Signs point to yes."
 * @param {'positive'|'neutral'|'negative'} type
 * @returns {Buffer}
 */
function renderEightBall(text, type) {
    const key = `${type}|${text}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const canvas = createCanvas(SIZE, SIZE);
    const ctx    = canvas.getContext('2d');

    drawBall(ctx);
    drawWindow(ctx, TINTS[type] ?? TINTS.neutral);
    drawAnswer(ctx, text);

    // The one canvas in the bot that keeps the synchronous encode (#592). It is
    // bounded in a way none of the others are: the answer table has twenty
    // entries, the cache above is keyed on the answer, so this line runs at
    // most twenty times in the life of the process and never again once each
    // answer has been drawn once. Making it async would turn every caller into
    // one that awaits a value the cache almost always already has.
    // eslint-disable-next-line no-restricted-syntax -- bounded to 20 encodes, see above
    const buffer = canvas.toBuffer('image/png');
    cache.set(key, buffer);
    return buffer;
}

module.exports = {
    renderEightBall,
    __test__: { cache, layoutAnswer, wrapInto, halfWidthAt, SIZE, TINTS, FONT },
};
