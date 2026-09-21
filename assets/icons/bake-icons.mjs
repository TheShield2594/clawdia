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

// A just-published CloudFront object can answer 403/404 for a short window
// while it propagates to the edge, and a single failed fetch fails the whole
// bake (one missing icon exits the job non-zero). So retry a few times with
// backoff before giving up — transient edge errors clear on the next attempt,
// and a genuinely missing url still fails after the retries are spent.
//
// Only genuinely transient responses are retried: the CloudFront 403/404
// propagation window, plus the usual 408/425/429/5xx server-side hiccups. A
// 400/401 or any other client error will never clear, so it fails immediately
// rather than waiting out the full backoff for a foregone result.
const TRANSIENT_STATUS = new Set([403, 404, 408, 425, 429, 500, 502, 503, 504]);

async function fetchBuffer(url, key, attempts = 4) {
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
        let res;
        try {
            res = await fetch(url);
        } catch (err) {
            lastErr = err; // network error (DNS, reset, timeout) — always transient
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
    if (!meta.url) throw new Error(`${key}: no url in icons.map.json`);
    const buf = await fetchBuffer(meta.url, key);
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
