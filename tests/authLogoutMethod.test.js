'use strict';

// #566. `GET /auth/logout` changed session state, which made it reachable from
// any page on the internet: an `<img src="https://dash.example.com/auth/logout">`
// on a site an admin happens to visit ended their session. No data crossed the
// boundary, so this is a nuisance rather than a breach — but the fix is the
// ordinary one, and these are the properties it has to have.

const express = require('express');
const request = require('supertest');

const DASHBOARD = 'https://dash.example.com';
let saved;

beforeAll(() => { saved = process.env.DASHBOARD_URL; process.env.DASHBOARD_URL = DASHBOARD; });
afterAll(() => {
    if (saved === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = saved;
});

const authRouter = require('../src/dashboard/routes/auth');

let loggedOut;

function app() {
    loggedOut = 0;
    const server = express();
    server.use((req, _res, next) => {
        req.logout = done => { loggedOut++; done(); };
        next();
    });
    server.use('/auth', authRouter);
    return server;
}

test('a same-origin POST logs the user out', async () => {
    const res = await request(app()).post('/auth/logout').set('Origin', DASHBOARD);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(loggedOut).toBe(1);
});

// The bug itself. A browser will not issue a POST for a subresource, so a GET
// that no longer exists is the whole fix.
test('GET is not a route at all', async () => {
    const res = await request(app()).get('/auth/logout');

    expect(res.status).toBe(404);
    expect(loggedOut).toBe(0);
});

test('a cross-origin POST is refused', async () => {
    const res = await request(app()).post('/auth/logout').set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(403);
    expect(loggedOut).toBe(0);
});

// A form POST that reaches the dashboard without an Origin header is not a
// browser doing what browsers do, and there is no CSRF token behind this.
test('a POST carrying neither Origin nor Fetch Metadata is refused', async () => {
    const res = await request(app()).post('/auth/logout');

    expect(res.status).toBe(403);
    expect(loggedOut).toBe(0);
});

test('Fetch Metadata is accepted when Origin is absent', async () => {
    const res = await request(app()).post('/auth/logout').set('Sec-Fetch-Site', 'same-origin');

    expect(res.status).toBe(302);
    expect(loggedOut).toBe(1);
});

// The controls that post to it. A link left behind would 404 in a user's face.
test('the dashboard view submits it as a form, with no logout links left', () => {
    const fs = require('fs');
    const path = require('path');
    const view = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'views', 'dashboard.ejs'), 'utf8');

    expect(view).not.toMatch(/href="\/auth\/logout"/);
    expect(view.match(/<form method="post" action="\/auth\/logout"/g)).toHaveLength(2);
});
