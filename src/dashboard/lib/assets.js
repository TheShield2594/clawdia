const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// `${root}\0${url path}` -> { mtimeMs, version }
//
// The root is part of the key rather than assumed: two roots serving the same
// url path are different files, and a cache that could not tell them apart
// would hand out the first one's hash for the second one's contents.
const cache = new Map();

/**
 * Content hash for a file under `public/`, recomputed whenever the file's mtime
 * changes so an edit is picked up without a restart in development.
 *
 * @param {string} urlPath - root-relative URL, e.g. "/styles.css"
 * @param {string} [publicDir] - the directory to resolve against. The dashboard
 *   serves one and never passes this; it is a parameter so that a test can hash
 *   a file it is free to rewrite. tests/assets used to write its fixture into
 *   the real `public/` and delete it again, which is a transient file inside
 *   src/ that any suite sweeping the tree in another Jest worker could see.
 * @returns {string|null} short hex digest, or null if the file cannot be read
 */
function assetVersion(urlPath, publicDir = PUBLIC_DIR) {
    const filePath = path.join(publicDir, urlPath.replace(/^\/+/, ''));
    // Never let a caller escape the public directory with "..".
    if (path.relative(publicDir, filePath).startsWith('..')) return null;

    let mtimeMs;
    try {
        ({ mtimeMs } = fs.statSync(filePath));
    } catch {
        return null;
    }

    const key = `${publicDir}\0${urlPath}`;
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === mtimeMs) return hit.version;

    let version;
    try {
        version = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 10);
    } catch {
        return null;
    }
    cache.set(key, { mtimeMs, version });
    return version;
}

/**
 * The minified twin of an asset path: "/styles.css" -> "/styles.min.css".
 *
 * @param {string} urlPath - root-relative URL
 * @returns {string} the twin's URL, whether or not it exists
 */
function minifiedTwin(urlPath) {
    const ext = path.extname(urlPath);
    return ext ? `${urlPath.slice(0, -ext.length)}.min${ext}` : urlPath;
}

/**
 * Stamp a static asset URL with its content hash, preferring a minified build.
 *
 * The dashboard's own responses are per-request and uncacheable, but the assets
 * they pull in are not — and guild-settings.js alone is ~250 KB. Hashing the
 * URL lets `express.static` serve them with a one-year immutable cache while a
 * deploy still busts the cache automatically, because changed content means a
 * changed URL.
 *
 * That is the transfer sorted for a returning visitor and does nothing for a
 * first load, where the file arrives gzipped but is still parsed in full.
 * scripts/build-assets.js writes a `.min` twin beside each of the dashboard's
 * own files, and this prefers it whenever one is present (#905). Present is the
 * whole condition: the twins are generated rather than committed, so a checkout
 * run straight with `npm start` finds none and serves the readable files it
 * always did, while the Docker image builds them and serves those. The views
 * ask for the same URL either way, and the hash below is taken from whichever
 * file is actually being served, so the cache key still describes the bytes.
 *
 * @param {string} urlPath - root-relative URL, e.g. "/guild-settings.js"
 * @param {string} [publicDir] - see assetVersion; the views never pass it.
 * @returns {string} the URL to serve with a `?v=` cache key, or the requested
 *   URL unchanged if the file is missing (a 404 is better surfaced than
 *   papered over).
 */
function asset(urlPath, publicDir = PUBLIC_DIR) {
    const twin = minifiedTwin(urlPath);
    const twinVersion = twin === urlPath ? null : assetVersion(twin, publicDir);
    if (twinVersion) return `${twin}?v=${twinVersion}`;

    const version = assetVersion(urlPath, publicDir);
    return version ? `${urlPath}?v=${version}` : urlPath;
}

/**
 * How long an asset reached without a matching `?v=` may be cached.
 *
 * Short enough that a regenerated file — a font rewritten under the same name
 * by scripts/fetch-fonts.sh, say — is picked up the same day, long enough that
 * a page's own assets are not re-fetched while a user clicks around it.
 */
const UNVERSIONED_MAX_AGE = 300;

/**
 * The `Cache-Control` express.static should send for one file.
 *
 * `express.static` cannot tell a hashed URL from a bare one, so an
 * unconditional `immutable` year covers URLs that carry no hash to bust —
 * public/fonts/fonts.css names every face by plain filename (#903). This
 * grants the year only to a request whose `v` matches what the file hashes to
 * right now, which is exactly the case asset() produces.
 *
 * @param {object} req - the Express request being served
 * @param {string} filePath - absolute path of the file about to be sent
 * @param {string} [publicDir] - the root it was resolved under
 * @returns {string} the Cache-Control header value
 */
function staticCacheControl(req, filePath, publicDir = PUBLIC_DIR) {
    const requested = req && req.query ? req.query.v : undefined;
    const relative = path.relative(publicDir, filePath);
    const versioned = typeof requested === 'string'
        && Boolean(relative)
        && !relative.startsWith('..')
        && requested === assetVersion(`/${relative.split(path.sep).join('/')}`, publicDir);

    return versioned
        ? 'public, max-age=31536000, immutable'
        : `public, max-age=${UNVERSIONED_MAX_AGE}`;
}

module.exports = { asset, assetVersion, minifiedTwin, staticCacheControl, UNVERSIONED_MAX_AGE, PUBLIC_DIR };
