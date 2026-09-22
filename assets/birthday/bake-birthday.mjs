#!/usr/bin/env node
'use strict';

/**
 * Download the birthday embed art from Higgsfield and bake it into the app.
 *
 *   npm install sharp
 *   node assets/birthday/bake-birthday.mjs
 *
 * Reads assets/birthday/birthday.map.json (each entry carries its CDN `url`, the
 * on-disk `file` name, and a `shape`), downloads each image, normalizes it, and
 * writes it to src/assets/birthday/<file> — the directory birthdayService serves
 * the default birthday icon/banner from (utils/birthdayFlair.js).
 *
 * Same idea and machinery as assets/icons/bake-icons.mjs, but two shapes rather
 * than one square: the author `icon` is trimmed, centered and padded into a
 * transparent 256×256 square (like the item icons); the `banner` keeps its wide
 * aspect ratio and is only resized down to a sane width and compressed.
 *
 * Runs in CI (.github/workflows/bake-birthday-art.yml) because a GitHub runner
 * can reach the Higgsfield CDN that a Claude Code sandbox cannot. Idempotent:
 * re-running overwrites the same files, so a regenerated image (a new job id in
 * the map) is picked up on the next run.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(repoRoot, 'src', 'assets', 'birthday');
const map = require(path.join(__dirname, 'birthday.map.json'));

const ICON_SIZE = 256;
const ICON_MARGIN = 0.08;
const CAP = 200 * 1024; // banners carry more detail than an icon; a looser cap

fs.mkdirSync(OUT_DIR, { recursive: true });

// A square, transparent, centered icon — the same normalize the item icons get.
async function normalizeIcon(buf, size = ICON_SIZE) {
    const pad = Math.round((size - Math.round(size * (1 - 2 * ICON_MARGIN))) / 2);
    const inner = size - 2 * pad;
    let out = await sharp(buf)
        .ensureAlpha()
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

// A wide banner — keep the aspect ratio, cap the width, compress. No square crop.
async function normalizeWide(buf, width = 1024) {
    let out = await sharp(buf)
        .resize({ width, withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
    if (out.length > CAP) {
        out = await sharp(out).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
    }
    return out;
}

const TRANSIENT_STATUS = new Set([403, 404, 408, 425, 429, 500, 502, 503, 504]);

// A just-published CloudFront object can answer 403/404 while it propagates to
// the edge, so retry transient responses with backoff; a permanent client error
// fails immediately rather than waiting out the whole backoff.
async function fetchBuffer(url, key, attempts = 4) {
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
        let res;
        try {
            res = await fetch(url);
        } catch (err) {
            lastErr = err;
        }
        if (res) {
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            if (!TRANSIENT_STATUS.has(res.status)) {
                throw new Error(`${key}: fetch ${res.status} ${res.statusText}`);
            }
            lastErr = new Error(`fetch ${res.status} ${res.statusText}`);
        }
        if (attempt < attempts - 1) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw new Error(`${key}: ${lastErr.message} after ${attempts} attempts`);
}

async function one([key, meta]) {
    if (!meta.url) throw new Error(`${key}: no url in birthday.map.json`);
    const buf = await fetchBuffer(meta.url, key);
    const out = meta.shape === 'wide'
        ? await normalizeWide(buf, meta.width)
        : await normalizeIcon(buf, meta.size);
    fs.writeFileSync(path.join(OUT_DIR, meta.file), out);
    return { key, bytes: out.length };
}

const entries = Object.entries(map.items);
const failures = [];
let done = 0;
for (const entry of entries) {
    try {
        const { key, bytes } = await one(entry);
        console.log(`  baked ${key} → ${entry[1].file} (${Math.round(bytes / 1024)} KB)`);
        done += 1;
    } catch (err) {
        failures.push(err.message);
    }
}

console.log(`baked ${done}/${entries.length} birthday assets into src/assets/birthday/`);
if (failures.length) {
    console.error(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
