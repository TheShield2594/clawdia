#!/usr/bin/env node
'use strict';

// Draws the landing page's Open Graph card into og-image.png (#687).
//
// Links to this bot are shared overwhelmingly *in Discord*, and Discord's
// unfurler wants a real raster image — it renders no SVG, so the favicon this
// repo already ships could not stand in for one. The card is therefore a
// committed PNG rather than something rendered per request: it never changes
// between deploys, and an unfurler that has to wait on the bot's own event loop
// to draw it is a page-load cost paid for every share.
//
//   npm run og-image             rewrite src/dashboard/public/og-image.png
//   npm run og-image -- --check  exit 1 if the PNG is missing or the wrong size
//
// `--check` is what tests/dashboardOpenGraph.test.js runs, and it checks the
// PNG's header rather than its bytes — libpng and the installed font files
// render the same drawing to different bytes across machines, exactly as
// scripts/make-favicon.js notes for the ICO.
//
// The type is DejaVu, not the page's Instrument Serif and Inter Tight. Those
// ship as woff2 for the browser and node-canvas registers only TrueType and
// OpenType, so matching the page exactly would mean vendoring a second copy of
// both families in a second format to draw one image. DejaVu is already a
// dependency of every card the bot draws (see src/utils/registerFonts.js), and
// the palette, the mark and the layout carry the brand here.

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { ensureFontsRegistered } = require('../src/utils/registerFonts');

const PNG = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'og-image.png');

// The size every unfurler is written against: Discord, Slack, X and iMessage
// all crop to roughly 1.91:1, and 1200×630 is the largest common source that
// none of them upscales.
const WIDTH = 1200;
const HEIGHT = 630;

// public/styles.css, verbatim.
const CREAM_50 = '#faf6ef';
const CREAM_100 = '#f3ecdd';
const CREAM_200 = '#e8dec6';
const INK_950 = '#14110d';
const INK_500 = '#6f6457';
const RUST = '#d97742';

const MARGIN = 84;

/**
 * The paw from partials/brand-mark.ejs, drawn at an arbitrary size.
 *
 * The same five ellipses and the same mouth stroke, on the partial's 32×32
 * viewBox, so the mark on the card and the mark in the nav are one shape rather
 * than two drawings that drifted.
 *
 * @param {import('canvas').CanvasRenderingContext2D} ctx
 * @param {number} x left edge, in canvas pixels
 * @param {number} y top edge
 * @param {number} size width and height of the 32×32 box
 * @param {string} fill the paw
 * @param {?string} accent the mouth stroke; null draws no mouth, which is what
 *   the oversized watermark wants — a hairline at that scale is a scratch
 */
function drawPaw(ctx, x, y, size, fill, accent) {
    const s = size / 32;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = fill;

    const ellipse = (cx, cy, rx, ry, degrees) => {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, (degrees * Math.PI) / 180, 0, Math.PI * 2);
        ctx.fill();
    };

    ellipse(16, 22, 8.5, 6, 0);
    ellipse(7, 12.5, 2.6, 3.8, -18);
    ellipse(12.5, 9, 2.6, 4, -6);
    ellipse(19.5, 9, 2.6, 4, 6);
    ellipse(25, 12.5, 2.6, 3.8, 18);

    if (accent) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(14, 20.5);
        ctx.bezierCurveTo(14.6, 18.9, 17.4, 18.9, 18, 20.5);
        ctx.stroke();
    }

    ctx.restore();
}

/** A rounded rectangle path, for the one pill on the card. */
function roundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}

function render() {
    ensureFontsRegistered();

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = CREAM_50;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Watermark paw, bleeding off the right edge. Cream-200 on cream-50 is a
    // four-step difference: it reads as texture at full size and disappears
    // entirely in the small thumbnail a mobile client may substitute, which is
    // the behaviour wanted from a decoration that carries no information.
    drawPaw(ctx, WIDTH - 350, HEIGHT - 396, 470, CREAM_200, null);

    // Ink rule down the left edge — the same device the page uses to mark the
    // hero, and the one element that keeps the card from reading as a
    // screenshot of a blank document when the image loads before the text.
    ctx.fillStyle = INK_950;
    ctx.fillRect(0, 0, 14, HEIGHT);

    // Lockup: mark then wordmark, baseline-aligned.
    drawPaw(ctx, MARGIN, 74, 52, INK_950, RUST);
    ctx.fillStyle = INK_950;
    ctx.font = '44px "DejaVu Serif"';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Clawdia', MARGIN + 68, 116);

    // Headline. Two lines rather than one: at 1200px a single line of this
    // length lands under 50px, which is the size a phone-sized unfurl loses.
    ctx.font = 'bold 78px "DejaVu Sans"';
    ctx.fillStyle = INK_950;
    ctx.fillText('A chill Discord bot', MARGIN, 300);
    ctx.fillText('with serious teeth.', MARGIN, 392);

    // The rust underline the hero draws beneath "serious teeth", under the
    // matching span of the second line.
    const teethStart = MARGIN + ctx.measureText('with ').width;
    const teethWidth = ctx.measureText('serious teeth.').width;
    ctx.fillStyle = RUST;
    roundedRect(ctx, teethStart, 406, teethWidth, 9, 4.5);
    ctx.fill();

    ctx.font = '31px "DejaVu Sans"';
    ctx.fillStyle = INK_500;
    ctx.fillText('Moderation · Leveling · Economy · AI chat · Analytics', MARGIN, 478);

    // Self-hosting is the actual differentiator, so it gets the one piece of
    // emphasis left on the card rather than a fourth line of grey.
    ctx.font = '25px "DejaVu Sans"';
    const pillText = 'Self-hosted · Own your data';
    const pillWidth = ctx.measureText(pillText).width + 56;
    ctx.fillStyle = CREAM_100;
    roundedRect(ctx, MARGIN, HEIGHT - 132, pillWidth, 58, 29);
    ctx.fill();
    ctx.fillStyle = RUST;
    ctx.fillText(pillText, MARGIN + 28, HEIGHT - 94);

    return canvas.toBuffer('image/png');
}

/**
 * Structural check on the PNG already on disk: a real PNG signature, and an
 * IHDR whose dimensions are the ones every unfurler is being promised.
 *
 * @returns {?string} the problem, or null when the file is fine
 */
function check() {
    if (!fs.existsSync(PNG)) return `${path.relative(process.cwd(), PNG)} is missing`;

    const png = fs.readFileSync(PNG);
    if (png.length < 24) return 'og-image.png is too short to hold a header';
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return 'og-image.png is not a PNG';
    if (png.subarray(12, 16).toString('ascii') !== 'IHDR') return 'og-image.png does not start with an IHDR chunk';

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width !== WIDTH || height !== HEIGHT) {
        return `og-image.png is ${width}×${height}, expected ${WIDTH}×${HEIGHT}`;
    }

    return null;
}

function main() {
    if (process.argv.includes('--check')) {
        const problem = check();
        if (problem) {
            console.error(`[OG] ${problem}. Run: npm run og-image`);
            process.exit(1);
        }
        console.log('[OG] og-image.png is up to date.');
        return;
    }

    fs.writeFileSync(PNG, render());
    console.log(`[OG] Wrote ${path.relative(process.cwd(), PNG)} (${WIDTH}×${HEIGHT}).`);
}

try {
    main();
} catch (err) {
    console.error('[OG]', err.message);
    process.exit(1);
}
