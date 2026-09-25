'use strict';

// #1161: `trust proxy` used to be 1 whenever NODE_ENV=production, so a
// production dashboard with no reverse proxy in front believed a client's own
// X-Forwarded-For — and every per-IP limit keyed on it.

const express = require('express');
const request = require('supertest');
const { resolveTrustProxy, PRIVATE_RANGES } = require('../src/dashboard/lib/trustProxy');

describe('resolveTrustProxy', () => {
    test('defaults: private ranges in production, nothing otherwise', () => {
        expect(resolveTrustProxy({ NODE_ENV: 'production' }).value).toBe(PRIVATE_RANGES);
        expect(resolveTrustProxy({ NODE_ENV: 'development' }).value).toBe(false);
        expect(resolveTrustProxy({}).value).toBe(false);
    });

    test('an explicit setting wins over NODE_ENV', () => {
        expect(resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: 'false' }).value).toBe(false);
        expect(resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: '0' }).value).toBe(false);
        expect(resolveTrustProxy({ TRUST_PROXY: '2' }).value).toBe(2);
        expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.5, 10.0.1.0/24' }).value).toBe('10.0.0.5, 10.0.1.0/24');
    });

    test('refuses to trust every hop', () => {
        expect(() => resolveTrustProxy({ TRUST_PROXY: 'true' })).toThrow(/X-Forwarded-For/);
    });
});

describe('the production default against a spoofed header', () => {
    function appWith(trust) {
        const app = express();
        if (trust !== false) app.set('trust proxy', trust);
        app.get('/ip', (req, res) => res.json({ ip: req.ip }));
        return app;
    }

    test('a proxy on a private address is believed', async () => {
        // supertest connects over loopback, which is what a same-host proxy is.
        const res = await request(appWith(resolveTrustProxy({ NODE_ENV: 'production' }).value))
            .get('/ip').set('X-Forwarded-For', '203.0.113.9');
        expect(res.body.ip).toBe('203.0.113.9');
    });

    test('with trust off, the header is ignored', async () => {
        const res = await request(appWith(resolveTrustProxy({ TRUST_PROXY: 'false' }).value))
            .get('/ip').set('X-Forwarded-For', '203.0.113.9');
        expect(res.body.ip).not.toBe('203.0.113.9');
    });

    test('a public peer is not a proxy, so its header is not believed', () => {
        // What Express does with the setting, checked directly: the trust
        // function says no for a public socket address.
        const app = appWith(resolveTrustProxy({ NODE_ENV: 'production' }).value);
        const trust = app.get('trust proxy fn');
        expect(trust('198.51.100.7', 0)).toBe(false);
        expect(trust('172.18.0.2', 0)).toBe(true);
        expect(trust('127.0.0.1', 0)).toBe(true);
    });
});
