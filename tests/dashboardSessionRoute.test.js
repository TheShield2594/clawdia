'use strict';

// The /session probe the dashboard's session-expired banner confirms itself
// against. Its whole value is being unambiguous: a plain 200 while the cookie
// authenticates, a plain 401 once it does not, and never a redirect for the
// probe to misread as either.
//
// Driven through the real router and the real checkAuth, with only
// req.isAuthenticated() supplied per test — the one thing passport would set.

const express = require('express');
const request = require('supertest');

const sessionRouter = require('../src/dashboard/routes/api/session');

function appWith(authenticated) {
    const app = express();
    app.use((req, _res, next) => { req.isAuthenticated = () => authenticated; next(); });
    app.use('/api/v1', sessionRouter);
    return app;
}

describe('GET /session', () => {
    it('answers 200 while the session still authenticates', async () => {
        const res = await request(appWith(true)).get('/api/v1/session');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ authenticated: true });
        expect(res.headers.location).toBeUndefined();
    });

    it('answers a clean 401 once it does not — never a redirect', async () => {
        const res = await request(appWith(false)).get('/api/v1/session');

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized' });
        // A page route would 302 to /auth/login here; the probe must not, or the
        // client cannot tell a dead session from a live one behind a redirect.
        expect(res.headers.location).toBeUndefined();
    });
});
