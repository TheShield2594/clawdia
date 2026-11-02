'use strict';

// CodeQL's js/missing-rate-limiting recognises a rate limiter only when it comes
// from a rate-limiting package, so the shared BoundedRateLimiter is invisible to
// it and it flags the /stats, /insights and item-image reads — each performs
// authorization (checkGuildAccess) with no limiter it can see. Those routes build
// an express-rate-limit limiter (shared options in lib/readRateLimit.js) and
// place it BETWEEN checkAuth and checkGuildAccess.
//
// Two things have to hold and are easy to regress: the limiter must actually
// reject past its limit, and it must sit before the authorization it guards (and
// after checkAuth, so it only counts authenticated requests). The first is
// exercised against the real package; the second is read from the route source.

const fs   = require('fs');
const path = require('path');

const { rateLimit } = require('express-rate-limit');
const { readRateLimitOptions } = require('../src/dashboard/lib/readRateLimit');

function makeRes() {
    return {
        statusCode: null,
        body: null,
        setHeader() {}, getHeader() {}, set() { return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
}

describe('readRateLimitOptions builds a working limiter', () => {
    test('passes up to the limit, then answers 429', async () => {
        const limiter = rateLimit(readRateLimitOptions(3));
        const req = { user: { id: 'admin-1' } };
        let passed = 0;
        const hit = () => new Promise(resolve => {
            const res = makeRes();
            limiter({ ...req, res }, res, () => { passed++; resolve(res); });
            // express-rate-limit resolves synchronously for the memory store, but
            // the handler path ends the response instead of calling next; give the
            // microtask queue a tick either way.
            setImmediate(() => resolve(res));
        });
        for (let i = 0; i < 3; i++) await hit();
        const blocked = await hit();
        expect(passed).toBe(3);
        expect(blocked.statusCode).toBe(429);
        expect(blocked.body).toEqual({ error: 'Too many requests. Please slow down.' });
    });

    test('counts per session, so one admin does not spend another\'s budget', async () => {
        const limiter = rateLimit(readRateLimitOptions(1));
        const call = id => new Promise(resolve => {
            const res = makeRes();
            limiter({ user: { id }, res }, res, () => resolve(res));
            setImmediate(() => resolve(res));
        });
        await call('loud');            // spends loud's only slot
        await call('loud');            // loud is now blocked
        const other = await call('quiet');
        expect(other.statusCode).toBeNull();
    });
});

// The install, read from source: the limiter is mounted with router.use ahead of
// every route in the file, which is what guards them — to CodeQL and at runtime.
// A router.use placed after a route would not cover it. It is mounted on the
// router's own paths, not bare: a pathless router.use meters every request that
// passes through the router on its way to a later one, which counted every
// item-image <img> on the economy panel against the 60-a-minute stats ceiling.
//
// Each mount names its paths, and every one must be there: dropping one leaves
// its route on the shared 120-a-minute budget with nothing in the source to say
// so (/insights would lose its 60-a-minute ceiling).
const FILES = [
    ['stats.js',      'statsReadRateLimit', ['/guild/:guildId/stats', '/guild/:guildId/insights']],
    ['itemImages.js', 'imageReadRateLimit', ['/item-image']],
];

describe('each router installs its read limiter ahead of its routes', () => {
    test.each(FILES)('%s mounts %s with router.use before any route', (file, limiter, paths) => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api', file), 'utf8',
        );
        const mount = src.match(new RegExp(`router\\.use\\(([^)]*?),\\s*${limiter}\\)`));
        expect(mount).not.toBeNull();
        expect(mount[1]).toMatch(/^\s*[['"]/);
        for (const p of paths) expect(mount[1]).toContain(`'${p}'`);
        const useIdx = mount.index;
        const firstRoute = src.search(/router\.(get|post|put|patch|delete)\(/);
        expect(useIdx).toBeGreaterThan(-1);
        expect(firstRoute).toBeGreaterThan(-1);
        expect(useIdx).toBeLessThan(firstRoute);
    });
});
