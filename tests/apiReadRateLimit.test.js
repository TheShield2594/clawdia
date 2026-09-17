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

// The ordering, read from source: a limiter after the guarded handler does not
// guard it, to CodeQL or at runtime.
const ROUTES = [
    ['stats.js',      "router.get('/guild/:guildId/stats'",                  'statsReadRateLimit'],
    ['stats.js',      "router.get('/guild/:guildId/insights'",               'statsReadRateLimit'],
    ['itemImages.js', "router.get('/item-image/shop/:guildId/:itemId'",      'imageReadRateLimit'],
    ['itemImages.js', "router.get('/item-image/activity/:guildId/:itemId'",  'imageReadRateLimit'],
];

describe('each flagged read gates authorization behind the limiter', () => {
    const cache = {};
    const routeLine = (file, marker) => {
        cache[file] ??= fs.readFileSync(
            path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api', file), 'utf8',
        ).split('\n');
        const line = cache[file].find(l => l.includes(marker));
        expect(line).toBeDefined();
        return line;
    };

    test.each(ROUTES)('%s %s carries %s between checkAuth and checkGuildAccess', (file, marker, limiter) => {
        const line = routeLine(file, marker);
        expect(line).toContain(limiter);
        expect(line.indexOf('checkAuth')).toBeLessThan(line.indexOf(limiter));
        expect(line.indexOf(limiter)).toBeLessThan(line.indexOf('checkGuildAccess'));
    });
});
