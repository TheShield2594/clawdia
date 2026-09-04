'use strict';

/**
 * #947. The dashboard answered /robots.txt with the same 404 every unmatched
 * path gets, so every crawler that found the landing page — and they find it,
 * it is the one page on the host that is not behind checkAuth — spent its first
 * request learning nothing and then walked into /dashboard and /auth, which
 * answer a redirect into Discord's OAuth, and /api, which answers 401.
 *
 * The file is static and lives in public/, so the static handler serves it
 * exactly as it serves the favicon. These drive the real app rather than
 * reading the file off disk: a robots.txt that is not reachable at /robots.txt
 * is not a robots.txt.
 */

const request = require('supertest');
const session = require('express-session');

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

const app = () => createApp({
    bot: { hasGuild: () => false },
    sessionStore: new session.MemoryStore(),
    configurePassport: () => {},
});

/** The `Disallow:` paths, in order, ignoring comments and blank lines. */
function disallowed(body) {
    return body
        .split('\n')
        .map(line => line.replace(/#.*$/, '').trim())
        .filter(line => /^Disallow:/i.test(line))
        .map(line => line.slice('Disallow:'.length).trim());
}

describe('/robots.txt', () => {
    test('is served, as text, instead of falling through to a 404', async () => {
        const res = await request(app()).get('/robots.txt');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/plain/);
    });

    test('addresses every crawler', async () => {
        const { text } = await request(app()).get('/robots.txt');
        expect(text).toMatch(/^User-agent: \*$/m);
    });

    test('keeps crawlers out of the three prefixes that need a session', async () => {
        const { text } = await request(app()).get('/robots.txt');
        expect(disallowed(text).sort()).toEqual(['/api', '/auth', '/dashboard']);
    });

    test('leaves the landing page and its assets crawlable', async () => {
        // A blanket `Disallow: /` would take the one page this file exists to
        // advertise with it — and the og:image the card points at, which an
        // unfurler is entitled to fetch.
        const { text } = await request(app()).get('/robots.txt');
        expect(disallowed(text)).not.toContain('/');
        expect(disallowed(text).some(path => '/og-image.png'.startsWith(path))).toBe(false);
    });
});
