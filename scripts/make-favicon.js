#!/usr/bin/env node
'use strict';

// Rasterises the dashboard's favicon.svg into favicon.ico.
//
// Safari does not read SVG favicons, and a browser that cannot use any icon the
// page links falls back to requesting /favicon.ico — which is the 404 on every
// fresh page load that #688 was about. So both files ship: the SVG scales, and
// the ICO is the one every browser can read.
//
//   npm run favicon             rewrite src/dashboard/public/favicon.ico
//   npm run favicon -- --check  exit 1 if the ICO is missing or malformed
//
// `--check` is what tests/dashboardFavicon.test.js runs. It checks the ICO's
// structure rather than its bytes: librsvg and libpng render the same drawing
// to slightly different bytes across versions, so a byte comparison would fail
// on a machine whose only difference is its system libraries.

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const PUBLIC = path.join(__dirname, '..', 'src', 'dashboard', 'public');
const SVG = path.join(PUBLIC, 'favicon.svg');
const ICO = path.join(PUBLIC, 'favicon.ico');

// 32 is the size a browser tab actually draws at 2× and the size Windows uses
// for a pinned site. One entry is enough: every consumer downscales, and the
// drawing is five ellipses that lose nothing on the way down.
const SIZE = 32;

/** Wrap a PNG in a single-image ICO container. */
function icoFromPng(png) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);   // reserved
    header.writeUInt16LE(1, 2);   // 1 = icon
    header.writeUInt16LE(1, 4);   // one image

    const entry = Buffer.alloc(16);
    entry.writeUInt8(SIZE % 256, 0);      // width  (0 would mean 256)
    entry.writeUInt8(SIZE % 256, 1);      // height
    entry.writeUInt8(0, 2);               // palette size: none, it is truecolour
    entry.writeUInt8(0, 3);               // reserved
    entry.writeUInt16LE(1, 4);            // colour planes
    entry.writeUInt16LE(32, 6);           // bits per pixel
    entry.writeUInt32LE(png.length, 8);   // payload size
    entry.writeUInt32LE(22, 12);          // payload offset: 6 + 16

    return Buffer.concat([header, entry, png]);
}

async function render() {
    const image = await loadImage(SVG);
    const canvas = createCanvas(SIZE, SIZE);
    canvas.getContext('2d').drawImage(image, 0, 0, SIZE, SIZE);
    return icoFromPng(canvas.toBuffer('image/png'));
}

/**
 * Structural check on the ICO already on disk: one 32×32 entry whose payload is
 * a PNG, sized and offset the way the directory entry claims. A truncated or
 * hand-edited file fails here rather than rendering as a broken image.
 */
function check() {
    if (!fs.existsSync(ICO)) return `${path.relative(process.cwd(), ICO)} is missing`;

    const ico = fs.readFileSync(ICO);
    if (ico.length < 22) return 'favicon.ico is too short to hold an icon directory';
    if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) return 'favicon.ico is not an icon file';
    if (ico.readUInt16LE(4) !== 1) return `favicon.ico declares ${ico.readUInt16LE(4)} images, expected 1`;

    const width = ico.readUInt8(6) || 256;
    const height = ico.readUInt8(7) || 256;
    if (width !== SIZE || height !== SIZE) return `favicon.ico is ${width}×${height}, expected ${SIZE}×${SIZE}`;

    const bytes = ico.readUInt32LE(14);
    const offset = ico.readUInt32LE(18);
    if (offset + bytes !== ico.length) return 'favicon.ico entry does not describe the file it is in';

    const png = ico.subarray(offset, offset + bytes);
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return 'favicon.ico payload is not a PNG';

    return null;
}

async function main() {
    if (process.argv.includes('--check')) {
        const problem = check();
        if (problem) {
            console.error(`[FAVICON] ${problem}. Run: npm run favicon`);
            process.exit(1);
        }
        console.log('[FAVICON] favicon.ico is up to date.');
        return;
    }

    fs.writeFileSync(ICO, await render());
    console.log(`[FAVICON] Wrote ${path.relative(process.cwd(), ICO)} (${SIZE}×${SIZE}).`);
}

main().catch(err => {
    console.error('[FAVICON]', err.message);
    process.exit(1);
});
