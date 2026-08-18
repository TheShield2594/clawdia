const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// url path -> { mtimeMs, version }
const cache = new Map();

/**
 * Content hash for a file under `public/`, recomputed whenever the file's mtime
 * changes so an edit is picked up without a restart in development.
 *
 * @param {string} urlPath - root-relative URL, e.g. "/styles.css"
 * @returns {string|null} short hex digest, or null if the file cannot be read
 */
function assetVersion(urlPath) {
    const filePath = path.join(PUBLIC_DIR, urlPath.replace(/^\/+/, ''));
    // Never let a caller escape the public directory with "..".
    if (path.relative(PUBLIC_DIR, filePath).startsWith('..')) return null;

    let mtimeMs;
    try {
        ({ mtimeMs } = fs.statSync(filePath));
    } catch {
        return null;
    }

    const hit = cache.get(urlPath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.version;

    let version;
    try {
        version = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 10);
    } catch {
        return null;
    }
    cache.set(urlPath, { mtimeMs, version });
    return version;
}

/**
 * Stamp a static asset URL with its content hash.
 *
 * The dashboard's own responses are per-request and uncacheable, but the assets
 * they pull in are not — and guild-settings.js alone is ~200 KB. Hashing the
 * URL lets `express.static` serve them with a one-year immutable cache while a
 * deploy still busts the cache automatically, because changed content means a
 * changed URL.
 *
 * @param {string} urlPath - root-relative URL, e.g. "/guild-settings.js"
 * @returns {string} the same URL with a `?v=` cache key, or unchanged if the
 *   file is missing (a 404 is better surfaced than papered over).
 */
function asset(urlPath) {
    const version = assetVersion(urlPath);
    return version ? `${urlPath}?v=${version}` : urlPath;
}

module.exports = { asset, assetVersion };
