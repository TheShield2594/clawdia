#!/usr/bin/env node
'use strict';

/**
 * Background removal by edge flood-fill — the FALLBACK for icons that arrive
 * opaque.  (STYLE.md §6)
 *
 * NOT needed on gpt_image_2_5 with `background: "transparent"` — those icons
 * already carry alpha, so the normal pipeline skips straight to prep-icons.mjs.
 * Keep this for an icon that arrives on a flat field (older model, a background
 * setting that didn't take, or art deliberately drawn on white).
 *
 *   npm install sharp
 *   node assets/icons/cutout.mjs <inDir> <outDir>
 *
 * It flood-fills inward from the image border, clearing only near-white pixels
 * reachable from the edge, so white *inside* the subject (behind a thick
 * outline) is never touched. It reports the percentage cleared per icon and
 * warns on the two failure modes: under 15% (background wasn't white) or over
 * 92% (fill leaked through a gap in the outline). A normal icon clears 40–85%.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

const WHITE = 238; // min(r,g,b) at/above this counts as "background"
const SOFT = 1; // 1 = 3x3 mean on the cut edge to soften it, 0 = hard edge

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
    console.error('usage: node cutout.mjs <inDir> <outDir>');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const isWhite = (data, i) => data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE;

async function cut(file) {
    const img = sharp(path.join(inDir, file));
    const { width, height } = await img.metadata();
    const { data } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = 4;
    const cleared = new Uint8Array(width * height);
    const stack = [];
    const push = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const p = y * width + x;
        if (cleared[p]) return;
        if (!isWhite(data, p * ch)) return;
        cleared[p] = 1;
        stack.push(p);
    };
    for (let x = 0; x < width; x++) {
        push(x, 0);
        push(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
        push(0, y);
        push(width - 1, y);
    }
    while (stack.length) {
        const p = stack.pop();
        const x = p % width;
        const y = (p / width) | 0;
        push(x - 1, y);
        push(x + 1, y);
        push(x, y - 1);
        push(x, y + 1);
    }
    let n = 0;
    for (let p = 0; p < cleared.length; p++) {
        if (cleared[p]) {
            data[p * ch + 3] = 0;
            n += 1;
        }
    }
    if (SOFT) {
        // soften alpha only on the boundary between kept and cleared
        const a = Uint8Array.from({ length: width * height }, (_, p) => data[p * ch + 3]);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = y * width + x;
                if (cleared[p]) continue;
                let edge = false;
                for (let dy = -1; dy <= 1 && !edge; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (cleared[ny * width + nx]) {
                            edge = true;
                            break;
                        }
                    }
                }
                if (!edge) continue;
                let sum = 0;
                let cnt = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        sum += a[ny * width + nx];
                        cnt += 1;
                    }
                }
                data[p * ch + 3] = Math.round(sum / cnt);
            }
        }
    }
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path.join(outDir, file));
    return (100 * n) / (width * height);
}

let failed = false;
const files = fs.readdirSync(inDir).filter((f) => f.toLowerCase().endsWith('.png'));
for (const file of files) {
    const pct = await cut(file);
    let flag = '';
    if (pct < 15) {
        flag = ' ⚠ under 15% — background may not have been white';
        failed = true;
    } else if (pct > 92) {
        flag = ' ⚠ over 92% — fill likely leaked through the outline';
        failed = true;
    }
    console.log(`${file}: cleared ${pct.toFixed(1)}%${flag}`);
}
process.exit(failed ? 1 : 0);
