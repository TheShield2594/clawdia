'use strict';

/**
 * The baseline response headers every dashboard route carries.
 *
 * #921: `X-XSS-Protection: 1; mode=block` used to read as a protection the
 * site does not actually have. The header is deprecated and ignored by current
 * browsers, and in the legacy ones that do honour it the auditor has itself
 * been a source of XS-Leaks and injection — so it is now set to `0`, and the
 * nonce-based CSP is what does the job.
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

function buildApp() {
    return createApp({
        bot: { hasGuild: () => false },
        sessionStore: new session.MemoryStore(),
        configurePassport: () => {},
    });
}

describe('baseline security headers', () => {
    test('the deprecated XSS auditor is switched off, not switched on', async () => {
        const res = await request(buildApp()).get('/');

        expect(res.headers['x-xss-protection']).toBe('0');
    });

    test('the headers that do carry weight are still set', async () => {
        const res = await request(buildApp()).get('/');

        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        // What actually replaces the auditor.
        expect(res.headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-/);
    });
});
