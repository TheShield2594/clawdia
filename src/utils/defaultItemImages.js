'use strict';

/**
 * Bundled default item artwork.
 *
 * The `itemimages` collection holds per-guild uploads (see itemImageHelper.js).
 * When a guild has not uploaded its own image for an item, we still want to show
 * the catalogue artwork rather than falling back to the item's emoji — so the
 * generated icon set ships *in the app* here, and getItemImageAttachment() uses
 * it as the last resort before giving up.
 *
 * The PNGs live under `src/` (not `assets/`) on purpose: the Docker build
 * context is an allowlist that ships `src/` and drops `assets/`, so runtime art
 * has to sit inside `src/` to be in the image. They are written by the
 * `bake-item-icons` GitHub Action (assets/icons/bake-icons.mjs), which can
 * reach the Higgsfield CDN that a sandbox cannot.
 *
 * On-disk filenames are the storage key with `:` written as `__`
 * (`hunt__steel_rifle.png`, `lucky_charm.png`) — the same convention the
 * generation pipeline uses (assets/icons/STYLE.md §4b).
 */

const fs = require('node:fs');
const path = require('node:path');

const ICON_DIR = path.join(__dirname, '..', 'assets', 'item-icons');

// filename stem <-> storage key: colons are illegal in filenames on some OSes,
// so the pipeline writes them as `__`.
const keyFromFile = (file) => file.slice(0, -'.png'.length).replace(/__/g, ':');

let index = null; // Map<itemId, absolute path>, built once
const bufferCache = new Map(); // itemId -> Buffer, filled on demand

function buildIndex() {
    const map = new Map();
    let files;
    try {
        files = fs.readdirSync(ICON_DIR);
    } catch {
        return map; // dir missing (e.g. icons not baked yet) — no defaults
    }
    for (const file of files) {
        if (!file.toLowerCase().endsWith('.png')) continue;
        map.set(keyFromFile(file), path.join(ICON_DIR, file));
    }
    return map;
}

/**
 * The bundled default image for an item, or null if none ships for it.
 * @returns {{ data: Buffer, type: string } | null}
 */
function getDefaultItemImage(itemId) {
    if (!index) index = buildIndex();
    const file = index.get(itemId);
    if (!file) return null;

    let buf = bufferCache.get(itemId);
    if (!buf) {
        try {
            buf = fs.readFileSync(file);
        } catch {
            return null; // listed at startup but unreadable now
        }
        bufferCache.set(itemId, buf);
    }
    return { data: buf, type: 'image/png' };
}

/** Test seam: drop the cached directory listing and buffers. */
function _reset() {
    index = null;
    bufferCache.clear();
}

module.exports = { getDefaultItemImage, _reset, ICON_DIR };
