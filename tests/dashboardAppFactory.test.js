'use strict';

const request = require('supertest');
const session = require('express-session');

// #620: the Express app was a module-level singleton configured inside
// `start(client)` — it could not be built without a Discord client, could not be
// built twice, and could not be driven without opening a socket. Nothing in
// src/dashboard/server.js had a test because of it.
//
// #616: and it is the same shape that makes an Express route error a bot-wide
// outage. The dashboard shares a process with the gateway, so an error that
// escapes the terminal middleware reaches the `uncaughtException` guard in
// src/index.js, which exits, which disconnects every guild. These tests hold
// the boundary: whatever a route does, the failure stops at the response.

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
    jest.restoreAllMocks();
});

const { createApp, errorHandler } = require('../src/dashboard/server');

// Every dependency the app reaches for at construction time, stubbed. The point
// of the factory is that this is possible at all: no Discord client, no Mongo,
// no Discord OAuth credentials.
function buildApp(overrides = {}) {
    return createApp({
        bot: { hasGuild: () => false },
        sessionStore: new session.MemoryStore(),
        configurePassport: () => {},
        ...overrides,
    });
}

describe('createApp', () => {
    test('builds an app with no Discord client and no listening socket', () => {
        const app = buildApp();
        expect(typeof app).toBe('function');
        expect(typeof app.listen).toBe('function');
    });

    test('builds twice, and the two apps are independent objects', () => {
        expect(buildApp()).not.toBe(buildApp());
    });

    test('the gateway facade it was handed is what routes see on req.bot', async () => {
        const bot = { hasGuild: () => true };
        const app = buildApp({ bot });
        let seen = null;
        app.get('/__bot', (req, res) => { seen = req.bot; res.end(); });

        await request(app).get('/__bot');
        expect(seen).toBe(bot);
    });

    test('still refuses to build without a usable SESSION_SECRET', () => {
        delete process.env.SESSION_SECRET;
        expect(() => buildApp()).toThrow(/SESSION_SECRET is not set/);

        process.env.SESSION_SECRET = 'too-short';
        expect(() => buildApp()).toThrow(/at least 32 characters/);
    });
});

describe('error containment', () => {
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

    test('a synchronous throw in a route becomes a 500, not a process exit', async () => {
        const app = buildApp();
        app.get('/__boom', () => { throw new Error('sync boom'); });
        app.use(errorHandler);

        const res = await request(app).get('/__boom');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    test('a rejected async route is caught too', async () => {
        const app = buildApp();
        app.get('/__boom', async () => { throw new Error('async boom'); });
        app.use(errorHandler);

        const res = await request(app).get('/__boom');
        expect(res.status).toBe(500);
    });

    test('a malformed JSON body is a 400, not laundered into a 500', async () => {
        const app = buildApp();
        app.post('/__echo', (req, res) => res.json(req.body));
        app.use(errorHandler);

        const res = await request(app)
            .post('/__echo')
            .set('Content-Type', 'application/json')
            .send('{"not":');

        expect(res.status).toBe(400);
    });

    test('an error after the response has started does not throw out of the handler', () => {
        const next = jest.fn();
        const res = {
            headersSent: true,
            status: () => { throw new Error('ERR_HTTP_HEADERS_SENT'); },
        };

        expect(() => errorHandler(new Error('late'), {}, res, next)).not.toThrow();
        // Delegated to Express's finalhandler, which destroys the socket — the
        // only correct end for a half-written response.
        expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    test('a write that fails on a dead socket is swallowed, not rethrown', () => {
        const destroy = jest.fn();
        const res = {
            headersSent: false,
            status: () => { throw new Error('socket hang up'); },
            destroy,
        };

        expect(() => errorHandler(new Error('boom'), {}, res, jest.fn())).not.toThrow();
        expect(destroy).toHaveBeenCalled();
    });
});
