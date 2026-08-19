'use strict';

// `checkWriteRateLimit` covered POST/PUT/DELETE on the assumption that a GET is
// cheap. Several dashboard GETs are not: /stats and /insights each run
// collection-wide aggregations over a guild's users and read a thousand
// moderation cases, and the container they run in has 1 GB. An authenticated
// guild admin looping either one spends far more of the bot's memory than of
// their own time.
//
// These tests cover the limiter itself and the wiring, because the wiring is the
// half that rots: a read limit listed per-route is a limit the next route added
// will not have.

const fs   = require('fs');
const path = require('path');
const { checkReadRateLimit } = require('../src/dashboard/lib/middleware');

const READ_RL_LIMIT = 120;

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
const freshUser = () => ({ id: `user-${++seq}` });

describe('checkReadRateLimit', () => {
    test('allows reads up to the limit and rejects the one after', () => {
        const req = { user: freshUser(), ip: '10.0.0.1' };
        const next = jest.fn();

        for (let i = 0; i < READ_RL_LIMIT; i++) checkReadRateLimit(req, makeRes(), next);
        expect(next).toHaveBeenCalledTimes(READ_RL_LIMIT);

        const res = makeRes();
        checkReadRateLimit(req, res, next);

        expect(next).toHaveBeenCalledTimes(READ_RL_LIMIT);
        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({ error: 'Too many requests. Please slow down.' });
    });

    test('counts per user, so one admin exhausting the budget does not lock out another', () => {
        const loud  = { user: freshUser(), ip: '10.0.0.1' };
        const quiet = { user: freshUser(), ip: '10.0.0.1' };

        for (let i = 0; i <= READ_RL_LIMIT; i++) checkReadRateLimit(loud, makeRes(), jest.fn());

        const res = makeRes();
        const next = jest.fn();
        checkReadRateLimit(quiet, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    test('falls back to the address when there is no session', () => {
        const req = { ip: `192.0.2.${++seq}` };
        const next = jest.fn();

        for (let i = 0; i < READ_RL_LIMIT; i++) checkReadRateLimit(req, makeRes(), next);
        const res = makeRes();
        checkReadRateLimit(req, res, next);

        expect(res.statusCode).toBe(429);
    });

    test('does not answer 401 itself — that is the routes\' checkAuth to give', () => {
        const res = makeRes();
        const next = jest.fn();

        checkReadRateLimit({ ip: `198.51.100.${++seq}` }, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeNull();
    });

    test('a user key cannot be spoofed by an address, or the reverse', () => {
        const id = `collide-${++seq}`;
        for (let i = 0; i <= READ_RL_LIMIT; i++) {
            checkReadRateLimit({ user: { id } }, makeRes(), jest.fn());
        }

        const res = makeRes();
        checkReadRateLimit({ ip: id }, res, jest.fn());

        expect(res.statusCode).toBeNull();
    });
});

// Origin validation was previously opted into per route and silently missing from
// nine of them. The read limit is mounted in the same place for the same reason,
// so this reads the mount rather than trusting that every route remembered.
describe('the API router applies it to every read', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api.js'), 'utf8',
    );
    // Everything up to the first sub-router mount: middleware placed after a mount
    // does not run for it.
    const beforeMounts = source.slice(0, source.indexOf("router.use(settingsRouter)"));

    test('routes GET and HEAD through the read limiter', () => {
        expect(beforeMounts).toContain('checkReadRateLimit');
        expect(beforeMounts).toMatch(/req\.method === 'GET'[\s\S]*checkReadRateLimit/);
    });

    test('still routes state-changing methods through origin validation', () => {
        expect(beforeMounts).toMatch(/return checkCsrfOrigin\(req, res, next\)/);
    });

    test('mounts both before any sub-router, so no route can be added outside them', () => {
        expect(source.indexOf('router.use((req, res, next)'))
            .toBeLessThan(source.indexOf("router.use(settingsRouter)"));
    });
});
