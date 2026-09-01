'use strict';

/**
 * #903. `express.static` was configured with `maxAge: '1y', immutable` for
 * every URL, but it knows nothing about the `?v=` hash that `lib/assets.js`
 * stamps on — so an asset reached without `asset()` got the same immutable
 * year with nothing to bust it. The clearest case is the fonts:
 * public/fonts/fonts.css names each face by bare filename, and
 * scripts/fetch-fonts.sh rewrites those files under the same names, so a
 * regenerated font stayed stale in every returning browser for up to a year.
 *
 * The policy is now decided per request, and these tests hold both halves:
 * a URL carrying the current hash still gets the immutable year, and a bare
 * one gets a short cache it can revalidate out of.
 */

const path = require('path');
const request = require('supertest');
const session = require('express-session');
const { assetVersion, staticCacheControl, UNVERSIONED_MAX_AGE, PUBLIC_DIR } = require('../src/dashboard/lib/assets');

const SAVED_ENV = { ...process.env };

beforeEach(() => {
    process.env.SESSION_SECRET = 'x'.repeat(48);
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/clawdia-test';
    process.env.NODE_ENV = 'test';
});

afterEach(() => {
    for (const key of ['SESSION_SECRET', 'MONGODB_URI', 'NODE_ENV']) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
});

const { createApp } = require('../src/dashboard/server');

function buildApp() {
    return createApp({
        bot: { hasGuild: () => false },
        sessionStore: new session.MemoryStore(),
        configurePassport: () => {},
    });
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = `public, max-age=${UNVERSIONED_MAX_AGE}`;

describe('staticCacheControl()', () => {
    const file = path.join(PUBLIC_DIR, 'styles.css');

    test('grants the immutable year to a URL carrying the current hash', () => {
        const version = assetVersion('/styles.css');
        expect(staticCacheControl({ query: { v: version } }, file)).toBe(IMMUTABLE);
    });

    test('gives a bare URL a short cache instead', () => {
        expect(staticCacheControl({ query: {} }, file)).toBe(SHORT);
    });

    test('gives a stale hash a short cache — the bytes moved on without it', () => {
        expect(staticCacheControl({ query: { v: 'deadbeef00' } }, file)).toBe(SHORT);
    });

    // `?v=a&v=b` parses to an array, and `?v[x]=1` to an object. Neither is a
    // hash, and neither should be compared as one.
    test('ignores a v that is not a single string', () => {
        expect(staticCacheControl({ query: { v: ['a', 'b'] } }, file)).toBe(SHORT);
        expect(staticCacheControl({ query: { v: { x: '1' } } }, file)).toBe(SHORT);
        expect(staticCacheControl({}, file)).toBe(SHORT);
    });

    test('never trusts a hash for a file outside the root it was resolved under', () => {
        const outside = path.join(PUBLIC_DIR, '..', 'server.js');
        expect(staticCacheControl({ query: { v: assetVersion('/styles.css') } }, outside)).toBe(SHORT);
    });
});

describe('the static handler', () => {
    test('caches a hashed asset URL for a year', async () => {
        const version = assetVersion('/styles.css');
        const res = await request(buildApp()).get(`/styles.css?v=${version}`);

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe(IMMUTABLE);
    });

    // The bare-filename case that started this: fonts.css itself goes through
    // asset(), but the woff2 URLs inside it do not.
    test('does not freeze an un-versioned font for a year', async () => {
        const res = await request(buildApp()).get('/fonts/fonts.css');

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe(SHORT);
        expect(res.headers['cache-control']).not.toContain('immutable');
    });
});

describe('public/fonts/fonts.css', () => {
    // Why the un-versioned branch has to exist at all — if this ever stops
    // being true the short cache is still correct, just no longer load-bearing.
    test('references its faces by bare filename', () => {
        const css = require('fs').readFileSync(path.join(PUBLIC_DIR, 'fonts', 'fonts.css'), 'utf8');
        expect(css).toMatch(/src: url\('\/fonts\/[a-z0-9-]+\.woff2'\)/);
    });
});
