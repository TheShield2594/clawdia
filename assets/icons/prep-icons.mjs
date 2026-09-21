#!/usr/bin/env node
'use strict';

/**
 * Normalize cut-out icons for the ItemImage collection.  (STYLE.md §7)
 *
 *   npm install sharp
 *   node assets/icons/prep-icons.mjs <inDir> <outDir>
 *   node assets/icons/prep-icons.mjs ./assets/icons/generated ./assets/icons/icons
 *
 * Trims transparent margin, re-centers, pads to a square, resizes to 256×256
 * and compresses. Input filenames must already be the storage-key filename
 * (`copper_rifle.png`, `hunt__steel_rifle.png`) — rename-icons.mjs guarantees
 * that. Output: 256×256 PNG with alpha, subject centered with an 8% margin,
 * typically well under 10 KB.
 *
 * - Rejects images with no alpha channel (sharp.trim() silently no-ops on an
 *   opaque image, which would ship un-normalized icons). Loud failure instead.
 * - Full-colour PNG first, palette only if over the size cap.
 * - Exits non-zero if any icon fails, so it is safe in CI or a pre-commit hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

const SIZE = 256;
const MARGIN = 0.08; // 8% of the canvas on each side
const CAP = 60 * 1024; // fall back to palette if a full-colour PNG exceeds this

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
    console.error('usage: node prep-icons.mjs <inDir> <outDir>');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

async function prep(file) {
    const src = sharp(path.join(inDir, file));
    const meta = await src.metadata();
    if (!meta.hasAlpha) {
        throw new Error('no alpha channel — did you skip the cut-out step?');
    }

    // trim transparent margin, then fit into the padded box
    const box = Math.round(SIZE * (1 - 2 * MARGIN));
    const pad = Math.round((SIZE - box) / 2);
    const inner = SIZE - 2 * pad; // derive from pad so the two sides sum to SIZE exactly

    const trimmed = await src
        .trim()
        .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();

    let out = trimmed;
    if (out.length > CAP) {
        out = await sharp(trimmed).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
    }
    await fs.promises.writeFile(path.join(outDir, file), out);
    return out.length;
}

let failed = false;
const files = fs.readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.png'));
for (const file of files) {
    try {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await prep(file);
        console.log(`${file}: ${(bytes / 1024).toFixed(1)} KB`);
    } catch (e) {
        console.error(`✗ ${file}: ${e.message}`);
        failed = true;
    }
}
process.exit(failed ? 1 : 0);
