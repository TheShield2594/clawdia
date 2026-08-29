'use strict';

/**
 * #616. The dashboard and the gateway share one process, so every way the
 * dashboard can fail is a way every guild can lose its bot.
 *
 * tests/dashboardAppFactory.test.js holds the request-time half of that line:
 * whatever a route does, the failure stops at the response. This file holds the
 * two failures that happen outside a request, where there is no `next(err)` to
 * catch them — the app cannot be built at all, and the port cannot be bound.
 *
 * Neither may reach the process-level `uncaughtException` guard in
 * src/index.js, because that guard exits.
 */

const session = require('express-session');
const { createApp, listen, start } = require('../src/dashboard/server');

const SAVED_ENV = { ...process.env };

beforeEach(() => {
    // `listen` announces itself on every bind; this file does several.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    process.env.SESSION_SECRET = 'x'.repeat(48);
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/clawdia-test';
    process.env.NODE_ENV = 'test';
});

afterEach(() => {
    for (const key of ['SESSION_SECRET', 'MONGODB_URI', 'NODE_ENV', 'DASHBOARD_PORT']) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    jest.restoreAllMocks();
});

const stubDeps = (overrides = {}) => ({
    bot: { hasGuild: () => false },
    sessionStore: new session.MemoryStore(),
    configurePassport: () => {},
    ...overrides,
});

/** Resolves once the server is listening, or rejects with whatever it emitted. */
function whenListening(server) {
    return new Promise((resolve, reject) => {
        if (server.listening) return resolve(server);
        server.once('listening', () => resolve(server));
        server.once('error', reject);
    });
}

const close = server => new Promise(resolve => server.close(resolve));

describe('a dashboard that cannot be built', () => {
    test('fails inside the caller, where src/index.js can catch it', () => {
        const boom = () => { throw new Error('session store is the wrong shape'); };

        // Synchronous, not a rejected promise and not a later tick: this is the
        // property the guard in startDashboard() depends on. A construction
        // failure that surfaced asynchronously would land on the process-level
        // handler instead, which is the outage this is here to prevent.
        expect(() => start({}, stubDeps({ configurePassport: boom })))
            .toThrow('session store is the wrong shape');
    });

    test('binds no socket on the way out', async () => {
        const boom = () => { throw new Error('nope'); };
        expect(() => start({}, stubDeps({ configurePassport: boom }))).toThrow();

        // The port is still free, so a later attempt — a restart, or an operator
        // starting a second instance — is not competing with a half-built one.
        const server = listen(createApp(stubDeps()), 0);
        await whenListening(server);
        expect(server.listening).toBe(true);
        await close(server);
    });
});

describe('a port that cannot be bound', () => {
    test('is logged and survived, not thrown at the process', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        const first = await whenListening(listen(createApp(stubDeps()), 0));
        const { port } = first.address();

        // An 'error' event with no listener is a process-level throw, which is
        // exactly how EADDRINUSE on the dashboard port used to take the gateway
        // down with it.
        const second = listen(createApp(stubDeps()), port);
        const failure = await new Promise(resolve => second.once('error', resolve));

        expect(failure.code).toBe('EADDRINUSE');
        expect(errors).toHaveBeenCalledWith(
            expect.stringContaining(`Server error on port ${port}`),
            expect.stringContaining('EADDRINUSE'),
        );

        await close(first);
    });
});
