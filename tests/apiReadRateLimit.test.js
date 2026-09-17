'use strict';

// CodeQL's js/missing-rate-limiting recognises a rate limiter only when it comes
// from a rate-limiting package, so the shared BoundedRateLimiter middleware is
// invisible to it and it flags the /stats, /insights and item-image reads — each
// performs authorization (checkGuildAccess) with no limiter it can see. Those
// routes carry an express-rate-limit limiter placed BEFORE checkGuildAccess.
//
// The order is the whole point: a limiter after the guarded handler does not
// guard it, to the analyser or at runtime. These tests read the route
// definitions so the ordering cannot regress unnoticed, and check the limiters
// are real middleware.

const fs   = require('fs');
const path = require('path');

const { statsReadRateLimit, imageReadRateLimit } = require('../src/dashboard/lib/middleware');

describe('the recognised read limiters', () => {
    test('are Express middleware', () => {
        for (const mw of [statsReadRateLimit, imageReadRateLimit]) {
            expect(typeof mw).toBe('function');
            // (req, res, next)
            expect(mw.length).toBeGreaterThanOrEqual(3);
        }
    });
});

// Each entry: file, the route line's leading marker, and the limiter that must
// appear on it before checkGuildAccess.
const ROUTES = [
    ['stats.js',      "router.get('/guild/:guildId/stats'",             'statsReadRateLimit'],
    ['stats.js',      "router.get('/guild/:guildId/insights'",          'statsReadRateLimit'],
    ['itemImages.js', "router.get('/item-image/shop/:guildId/:itemId'",     'imageReadRateLimit'],
    ['itemImages.js', "router.get('/item-image/activity/:guildId/:itemId'", 'imageReadRateLimit'],
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

    test.each(ROUTES)('%s %s carries %s before checkGuildAccess', (file, marker, limiter) => {
        const line = routeLine(file, marker);
        expect(line).toContain(limiter);
        // The limiter must sit ahead of the authorization check it protects.
        expect(line.indexOf(limiter)).toBeLessThan(line.indexOf('checkGuildAccess'));
        // …and behind checkAuth, so it only ever counts authenticated requests.
        expect(line.indexOf('checkAuth')).toBeLessThan(line.indexOf(limiter));
    });
});
