'use strict';

/**
 * Bakes the slot machine's symbol art into src/assets/slot-symbols/.
 *
 * The art is Twemoji — the emoji set Discord itself draws — so the paytable
 * image shows exactly the symbols a player sees on the reels. It is shipped as
 * PNG because the runtime image's node-canvas is built without librsvg and
 * cannot decode SVG; this script runs where it can.
 *
 *     npm pack @twemoji/svg@15 && tar -xzf twemoji-svg-15.0.0.tgz
 *     node scripts/bake-slot-symbols.js package
 *
 * Twemoji graphics are © Twitter, Inc and other contributors, licensed under
 * CC-BY 4.0; see src/assets/slot-symbols/ATTRIBUTION.md.
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const SIZE = 256;
const OUT = path.join(__dirname, '..', 'src', 'assets', 'slot-symbols');

// File name → Twemoji code point.
const SYMBOLS = {
    cherry: '1f352', lemon: '1f34b', grape: '1f347', bell: '1f514', diamond: '1f48e',
    star: '1f31f', wild: '1f0cf', boost: '26a1', scatter: '1f338',
    slots: '1f3b0', fire: '1f525', clover: '1f340', trophy: '1f3c6',
};

async function main() {
    const src = process.argv[2];
    if (!src) throw new Error('usage: node scripts/bake-slot-symbols.js <path to @twemoji/svg package>');
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, code] of Object.entries(SYMBOLS)) {
        // Twemoji's SVGs carry only a viewBox; librsvg needs a size to rasterise.
        const svg = fs.readFileSync(path.join(src, `${code}.svg`), 'utf8')
            .replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `);
        const img = await loadImage(Buffer.from(svg));
        const canvas = createCanvas(SIZE, SIZE);
        canvas.getContext('2d').drawImage(img, 0, 0, SIZE, SIZE);
        fs.writeFileSync(path.join(OUT, `${name}.png`), canvas.toBuffer('image/png'));
        console.log(`${name}.png ← ${code}.svg`);
    }
}

main().catch(err => { console.error(err.message); process.exit(1); });
