'use strict';

// The item-image `GET`s do a keyed database read per request, which CodeQL's
// js/missing-rate-limiting flags when no rate limiter sits in the handler's own
// chain — it does not trace the router-wide read limiter in routes/api.js, which
// is why the sibling member routes carry a limiter directly too (#1009).
//
// They carry a limiter of their own rather than the read or write one, because
// both are the wrong budget: these are `<img>` subresources a single page loads
// in bulk (the activity-items page renders the whole ~80-item catalogue), so the
// write budget would leave an admin unable to save and the shared read budget
// would count them twice and starve the page's own data GETs.
//
// These tests cover the limiter and the wiring, because the wiring is the half
// that rots: a limiter listed per-route is one the next route added will forget.

const fs   = require('fs');
const path = require('path');
const { checkImageReadRateLimit } = require('../src/dashboard/lib/middleware');

const IMAGE_READ_RL_LIMIT = 240;

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

// Distinct per test so one test's spent budget is not another's starting point —
// the limiter's window is a minute and its state is module-level.
let seq = 0;
const freshUser = () => ({ id: `image-user-${++seq}` });

describe('checkImageReadRateLimit', () => {
    test('allows reads up to the limit and rejects the one after', () => {
        const req = { user: freshUser(), ip: '10.0.0.1' };
        const next = jest.fn();

        for (let i = 0; i < IMAGE_READ_RL_LIMIT; i++) checkImageReadRateLimit(req, makeRes(), next);
        expect(next).toHaveBeenCalledTimes(IMAGE_READ_RL_LIMIT);

        const res = makeRes();
        checkImageReadRateLimit(req, res, next);

        expect(next).toHaveBeenCalledTimes(IMAGE_READ_RL_LIMIT);
        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({ error: 'Too many requests. Please slow down.' });
    });

    test('has headroom above a full page of images so a legitimate render never trips it', () => {
        // The activity-items page renders one card per catalogue item; the limit
        // sits well above that so uploading art for every one and then loading
        // the page does not 429 the icons.
        const catalogue = require('../src/data/activityItems').ACTIVITY_ITEM_IDS;
        const count = Array.isArray(catalogue) ? catalogue.length : catalogue.size;

        const req = { user: freshUser(), ip: '10.0.0.1' };
        const next = jest.fn();
        for (let i = 0; i < count; i++) checkImageReadRateLimit(req, makeRes(), next);

        expect(next).toHaveBeenCalledTimes(count);
        expect(count).toBeLessThan(IMAGE_READ_RL_LIMIT);
    });

    test('counts on a budget of its own, separate from the shared read limit', () => {
        // A user who has spent their image budget can still make ordinary reads:
        // the two limiters are different instances, so this one going to 429 says
        // nothing about checkReadRateLimit.
        const { checkReadRateLimit } = require('../src/dashboard/lib/middleware');
        const req = { user: freshUser(), ip: '10.0.0.1' };

        for (let i = 0; i <= IMAGE_READ_RL_LIMIT; i++) checkImageReadRateLimit(req, makeRes(), jest.fn());

        const res = makeRes();
        const next = jest.fn();
        checkReadRateLimit(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    test('counts per user, so one admin exhausting the budget does not lock out another', () => {
        const loud  = { user: freshUser(), ip: '10.0.0.1' };
        const quiet = { user: freshUser(), ip: '10.0.0.1' };

        for (let i = 0; i <= IMAGE_READ_RL_LIMIT; i++) checkImageReadRateLimit(loud, makeRes(), jest.fn());

        const res = makeRes();
        const next = jest.fn();
        checkImageReadRateLimit(quiet, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    test('falls back to the address when there is no session', () => {
        const req = { ip: `192.0.2.${++seq}` };
        const next = jest.fn();

        for (let i = 0; i < IMAGE_READ_RL_LIMIT; i++) checkImageReadRateLimit(req, makeRes(), next);
        const res = makeRes();
        checkImageReadRateLimit(req, res, next);

        expect(res.statusCode).toBe(429);
    });

    test('does not answer 401 itself — that is the routes\' checkAuth to give', () => {
        const res = makeRes();
        const next = jest.fn();

        checkImageReadRateLimit({ ip: `198.51.100.${++seq}` }, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });
});

// A limiter listed per route is one the next route forgets. Both item-image
// reads carry it, after the two gates that can short-circuit the request so an
// unauthenticated or cross-guild caller is answered by those, not counted here.
describe('both item-image reads carry it', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api', 'itemImages.js'), 'utf8',
    );

    test.each([
        ["router.get('/item-image/shop/:guildId/:itemId'"],
        ["router.get('/item-image/activity/:guildId/:itemId'"],
    ])('%s', prefix => {
        const line = source.split('\n').find(l => l.includes(prefix));
        expect(line).toBeDefined();
        expect(line).toContain('checkAuth, checkGuildAccess, checkImageReadRateLimit');
    });
});
