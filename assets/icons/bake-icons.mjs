#!/usr/bin/env node
'use strict';

/**
 * Download the generated catalogue from Higgsfield and bake it into the app.
 *
 *   npm install sharp
 *   node assets/icons/bake-icons.mjs
 *
 * Reads assets/icons/icons.map.json (each item carries its CDN `url` and the
 * on-disk `file` name), downloads each image, normalizes it exactly like
 * prep-icons.mjs (trim → center → 8% pad → 256×256 → compress), and writes it
 * to src/assets/item-icons/<file> — the directory the running app serves default
 * item art from (defaultItemImages.js).
 *
 * This is meant to run in CI (.github/workflows/bake-item-icons.yml), because a
 * GitHub Action runner can reach the Higgsfield CDN that a sandbox cannot. It is
 * idempotent: re-running overwrites the same files, so a regenerated icon (a new
 * job id in the map) is picked up on the next run.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(repoRoot, 'src', 'assets', 'item-icons');
const map = require(path.join(__dirname, 'icons.map.json'));

const SIZE = 256;
const MARGIN = 0.08;
const CAP = 60 * 1024;

fs.mkdirSync(OUT_DIR, { recursive: true });

async function normalize(buf) {
    const pad = Math.round((SIZE - Math.round(SIZE * (1 - 2 * MARGIN))) / 2);
    const inner = SIZE - 2 * pad;
    const src = sharp(buf).ensureAlpha();
    let out = await src
        .trim()
        .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
    if (out.length > CAP) {
        out = await sharp(out).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
    }
    return out;
}

async function one([key, meta]) {
    if (!meta.url) throw new Error(`${key}: no url in icons.map.json`);
    const res = await fetch(meta.url);
    if (!res.ok) throw new Error(`${key}: fetch ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const out = await normalize(buf);
    fs.writeFileSync(path.join(OUT_DIR, meta.file), out);
    return { key, bytes: out.length };
}

const entries = Object.entries(map.items);
const failures = [];
let done = 0;
// modest concurrency — the CDN is fine with it and it keeps CI quick
const CONCURRENCY = 8;
for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const slice = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(slice.map(one));
    results.forEach((r, j) => {
        if (r.status === 'fulfilled') {
            done += 1;
        } else {
            failures.push(`${slice[j][0]}: ${r.reason.message}`);
        }
    });
}

console.log(`baked ${done}/${entries.length} icons into src/assets/item-icons/`);
if (failures.length) {
    console.error(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
