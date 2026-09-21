#!/usr/bin/env node
'use strict';

/**
 * Match Higgsfield downloads back to item ids.  (STYLE.md §5)
 *
 *   node assets/icons/rename-icons.mjs <downloadsDir> <outDir>
 *   node assets/icons/rename-icons.mjs ~/Downloads ./assets/icons/generated
 *
 * Higgsfield names every download `hf_<date>_<job_id>.png`. Nothing in that
 * name says which item it is. This reads the job_id out of each filename, looks
 * it up in icons.map.json, and writes a *copy* named `<itemId>.png` (colons in
 * activity keys become `__`, matching the storage-key filename in the map).
 *
 * It copies rather than moves, reports unknown job_ids instead of guessing,
 * refuses when two files map to the same item, lists which mapped items are
 * still missing, and exits non-zero if anything was unresolved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [srcDir, outDir] = process.argv.slice(2);

if (!srcDir || !outDir) {
    console.error('usage: node rename-icons.mjs <downloadsDir> <outDir>');
    process.exit(2);
}

const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'icons.map.json'), 'utf8'));
// jobId -> { key, file }
const byJob = new Map();
for (const [key, v] of Object.entries(map.items)) {
    if (v.jobId) byJob.set(v.jobId, { key, file: v.file });
}

fs.mkdirSync(outDir, { recursive: true });

const JOB_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const entries = fs.readdirSync(srcDir);

const unknown = [];
const written = new Map(); // itemFile -> source filename (to catch collisions)
let count = 0;
let collision = false;

for (const name of entries) {
    if (!name.toLowerCase().endsWith('.png')) continue; // skips _min.webp previews
    const m = name.match(JOB_RE);
    if (!m) continue;
    const hit = byJob.get(m[1].toLowerCase());
    if (!hit) {
        unknown.push(name);
        continue;
    }
    if (written.has(hit.file)) {
        console.error(`✗ collision: "${name}" and "${written.get(hit.file)}" both map to ${hit.file} — refusing to overwrite`);
        collision = true;
        continue;
    }
    written.set(hit.file, name);
    fs.copyFileSync(path.join(srcDir, name), path.join(outDir, hit.file));
    count += 1;
}

const missing = [...byJob.values()].map((v) => v.file).filter((f) => !written.has(f));

console.log(`✓ wrote ${count} icons to ${outDir}`);
if (unknown.length) console.warn(`? ${unknown.length} unknown job_ids (not in map): ${unknown.join(', ')}`);
if (missing.length) console.warn(`… ${missing.length} mapped items still missing from ${srcDir}:\n  ${missing.join('\n  ')}`);

process.exit(collision || unknown.length ? 1 : 0);
