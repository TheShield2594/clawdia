'use strict';

// #904. Every JSON API response is one guild's private data, fetched with a
// session cookie, and none of them said anything about caching. The HTML pages
// that render that data have sent `private, no-store` since they were written;
// the endpoints they read it from sent no Cache-Control at all, which leaves a
// browser's disk cache, the bfcache and any intermediary to decide for
// themselves how long a cookie-authenticated 200 may be kept.
//
// The header is mounted once on the API router rather than listed per route,
// so these tests drive the real router — a header that only some routes
// remember to send is the failure being fixed, not a smaller version of it.

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const request = require('supertest');

const apiRouter = require('../src/dashboard/routes/api');

// Unauthenticated: checkAuth answers 401 before any handler touches the
// database, which is enough to see what the router put on the way out. Passport
// is not mounted here, so req.isAuthenticated has to exist for checkAuth to
// call it.
function makeApp() {
    const app = express();
    app.use((req, res, next) => { req.isAuthenticated = () => false; next(); });
    app.use('/api', apiRouter);
    return app;
}

describe('the API router marks every response uncacheable', () => {
    const app = makeApp();

    // One per sub-router that reads guild data, named in the issue: stats,
    // insights, settings, member search and cases.
    test.each([
        ['/api/guild/123/stats'],
        ['/api/guild/123/insights'],
        ['/api/guild/123/settings'],
        ['/api/guild/123/members/search?q=a'],
        ['/api/guild/123/cases'],
    ])('%s sends private, no-store', async url => {
        const res = await request(app).get(url);
        expect(res.headers['cache-control']).toBe('private, no-store');
    });

    // The header has to be on the rejection too: a 401 or a 403 body is not
    // sensitive, but a response cached under the URL of one that is would be
    // served back in place of it.
    test('an unauthorized response carries it as well', async () => {
        const res = await request(app).get('/api/guild/123/stats');
        expect(res.status).toBe(401);
        expect(res.headers['cache-control']).toBe('private, no-store');
    });

    test('a write rejected for its origin carries it too', async () => {
        const res = await request(app)
            .post('/api/guild/123/settings')
            .set('Origin', 'https://not-the-dashboard.example');
        expect(res.headers['cache-control']).toBe('private, no-store');
    });
});

// The wiring, read as source: middleware mounted after a sub-router does not
// run for it, so where this sits is the whole of what makes it router-wide.
describe('it is mounted where a later route cannot escape it', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api.js'), 'utf8',
    );
    const beforeMounts = source.slice(0, source.indexOf('router.use(settingsRouter)'));

    test('before any sub-router is mounted', () => {
        expect(beforeMounts).toMatch(/Cache-Control'\s*,\s*'private, no-store'/);
    });

    test('and before the checks that can short-circuit a request', () => {
        // Against the mount, not the require at the top of the file.
        expect(beforeMounts.indexOf("res.set('Cache-Control'"))
            .toBeLessThan(beforeMounts.indexOf('return checkReadRateLimit(req, res, next)'));
    });
});

// The router-wide default is a floor, not a ceiling: a handler that has a
// reason to allow caching sets its own header and wins, because it runs later.
// The two item-image reads are the only routes that do, and they are the reason
// the default cannot simply be forced on the way out.
describe('a route with its own policy still overrides it', () => {
    test('a later res.set replaces the router-wide value', async () => {
        const app = express();
        app.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
        app.get('/image', (req, res) => {
            res.set('Cache-Control', 'private, max-age=86400');
            res.end();
        });

        const res = await request(app).get('/image');
        expect(res.headers['cache-control']).toBe('private, max-age=86400');
    });

    test('item image reads still declare their own max-age', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api', 'itemImages.js'),
            'utf8',
        );
        expect(source.match(/'Cache-Control', 'private, max-age=86400'/g)).toHaveLength(2);
    });
});
