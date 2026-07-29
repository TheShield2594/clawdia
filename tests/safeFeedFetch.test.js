'use strict';

// Feed URLs are operator-supplied, so this module is the boundary that keeps a
// dashboard admin from turning the bot into an SSRF proxy. Every branch below
// is a way that boundary could be walked around.

const dns = require('dns');
const http = require('http');
const { EventEmitter } = require('events');

const { isPrivateIp, resolveAndPin, safeFetchFeed } = require('../src/utils/safeFeedFetch');

describe('isPrivateIp', () => {
    const blocked = [
        ['0.0.0.0', 'this-network'],
        ['127.0.0.1', 'loopback'],
        ['127.255.255.254', 'loopback upper'],
        ['10.0.0.1', 'RFC1918 /8'],
        ['10.255.255.255', 'RFC1918 /8 upper'],
        ['172.16.0.1', 'RFC1918 /12 lower'],
        ['172.31.255.255', 'RFC1918 /12 upper'],
        ['192.168.1.1', 'RFC1918 /16'],
        ['169.254.169.254', 'cloud metadata'],
        ['100.64.0.1', 'CGNAT lower'],
        ['100.127.255.255', 'CGNAT upper'],
        ['224.0.0.1', 'multicast'],
        ['239.255.255.255', 'multicast upper'],
        ['240.0.0.1', 'reserved'],
        ['255.255.255.255', 'broadcast'],
        ['::1', 'IPv6 loopback'],
        ['::', 'IPv6 unspecified'],
        ['fc00::1', 'IPv6 ULA'],
        ['fd12:3456::1', 'IPv6 ULA'],
        ['fe80::1', 'IPv6 link-local'],
        ['ff02::1', 'IPv6 multicast'],
        ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
        ['64:ff9b::1', 'NAT64'],
        ['2001:db8::1', 'documentation'],
        ['100::1', 'discard prefix'],
    ];

    it.each(blocked)('blocks %s (%s)', (ip) => {
        expect(isPrivateIp(ip)).toBe(true);
    });

    const allowed = [
        '8.8.8.8',
        '1.1.1.1',
        '93.184.216.34',
        '172.15.255.255',  // just below the RFC1918 /12 range
        '172.32.0.1',      // just above it
        '100.63.255.255',  // just below CGNAT
        '100.128.0.1',     // just above CGNAT
        '192.167.1.1',     // just below 192.168/16
        '192.169.1.1',     // just above it
        '223.255.255.255', // just below multicast
        '2606:4700:4700::1111',
    ];

    it.each(allowed)('allows public address %s', (ip) => {
        expect(isPrivateIp(ip)).toBe(false);
    });

    it('blocks anything that is not a recognisable IP', () => {
        for (const value of ['', 'not-an-ip', 'localhost', '999.999.999.999', null, undefined]) {
            expect(isPrivateIp(value)).toBe(true);
        }
    });
});

describe('resolveAndPin', () => {
    afterEach(() => jest.restoreAllMocks());

    function mockLookup(err, results) {
        jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => cb(err, results));
    }

    it('returns the first address when every result is public', async () => {
        mockLookup(null, [{ address: '93.184.216.34' }, { address: '8.8.8.8' }]);
        await expect(resolveAndPin('example.com')).resolves.toBe('93.184.216.34');
    });

    it('rejects when any resolved address is private', async () => {
        // A hostname resolving to both a public and a private address must be
        // refused outright — picking the public one would still let a rebind
        // land on the private one.
        mockLookup(null, [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]);
        await expect(resolveAndPin('rebind.example')).rejects.toThrow(/private or reserved/);
    });

    it('rejects a hostname that resolves only to metadata', async () => {
        mockLookup(null, [{ address: '169.254.169.254' }]);
        await expect(resolveAndPin('metadata.example')).rejects.toThrow(/private or reserved/);
    });

    it('gives up on a DNS lookup that never calls back', async () => {
        // dns.lookup has no timeout of its own and getaddrinfo is not
        // cancellable, so an unreachable nameserver would otherwise stall the hop
        // indefinitely — before the request deadline is even armed — while
        // holding one of libuv's four default threadpool slots.
        jest.useFakeTimers();
        try {
            jest.spyOn(dns, 'lookup').mockImplementation(() => { /* never calls back */ });

            const pending = resolveAndPin('blackhole.example');
            const assertion = expect(pending).rejects.toThrow(/DNS lookup for "blackhole.example" exceeded/);
            await jest.advanceTimersByTimeAsync(8_001);
            await assertion;
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not leave the deadline pending after a successful lookup', async () => {
        jest.useFakeTimers();
        try {
            mockLookup(null, [{ address: '93.184.216.34' }]);
            await expect(resolveAndPin('example.com')).resolves.toBe('93.184.216.34');

            // The deadline timer must have been cleared; if it were still armed it
            // would fire here with no handler attached.
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not leave the deadline pending after a rejected lookup', async () => {
        jest.useFakeTimers();
        try {
            mockLookup(new Error('ENOTFOUND'), null);
            await expect(resolveAndPin('nope.example')).rejects.toThrow(/DNS lookup failed/);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('rejects when DNS fails', async () => {
        mockLookup(new Error('ENOTFOUND'), null);
        await expect(resolveAndPin('nope.example')).rejects.toThrow(/DNS lookup failed/);
    });

    it('rejects when the hostname resolves to nothing', async () => {
        mockLookup(null, []);
        await expect(resolveAndPin('empty.example')).rejects.toThrow(/no addresses/);
    });
});

describe('safeFetchFeed', () => {
    afterEach(() => jest.restoreAllMocks());

    // Minimal stand-in for http.request: hands the callback a fake response.
    function mockRequest(makeResponse) {
        jest.spyOn(http, 'request').mockImplementation((opts, cb) => {
            const req = new EventEmitter();
            req.end = () => setImmediate(() => makeResponse(cb, req));
            req.destroy = jest.fn();
            return req;
        });
    }

    function respond(cb, { statusCode = 200, headers = {}, chunks = [] }) {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.headers = headers;
        res.destroy = jest.fn();
        cb(res);
        setImmediate(() => {
            for (const c of chunks) res.emit('data', Buffer.from(c));
            res.emit('end');
        });
    }

    function allowPublicDns() {
        jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) =>
            cb(null, [{ address: '93.184.216.34' }]));
    }

    it('returns the body for a normal response', async () => {
        allowPublicDns();
        mockRequest((cb) => respond(cb, { chunks: ['<rss>', 'ok</rss>'] }));
        await expect(safeFetchFeed('http://example.com/feed')).resolves.toBe('<rss>ok</rss>');
    });

    it('refuses a URL that resolves to a private address before connecting', async () => {
        jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) =>
            cb(null, [{ address: '169.254.169.254' }]));
        const request = jest.spyOn(http, 'request');

        await expect(safeFetchFeed('http://metadata.example/')).rejects.toThrow(/private or reserved/);
        expect(request).not.toHaveBeenCalled();
    });

    it('re-validates DNS on a redirect, so a redirect to a private host is refused', async () => {
        // The whole point of pinning per hop: a public URL that 302s to
        // 169.254.169.254 must not be followed.
        jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
            if (host === 'evil.example') return cb(null, [{ address: '127.0.0.1' }]);
            return cb(null, [{ address: '93.184.216.34' }]);
        });
        mockRequest((cb) => respond(cb, {
            statusCode: 302,
            headers: { location: 'http://evil.example/internal' },
        }));

        await expect(safeFetchFeed('http://example.com/feed')).rejects.toThrow(/private or reserved/);
    });

    it('rejects a redirect to a non-HTTP protocol', async () => {
        allowPublicDns();
        mockRequest((cb) => respond(cb, {
            statusCode: 301,
            headers: { location: 'file:///etc/passwd' },
        }));

        await expect(safeFetchFeed('http://example.com/feed')).rejects.toThrow(/non-HTTP protocol/);
    });

    it('rejects a redirect with an empty Location header', async () => {
        allowPublicDns();
        mockRequest((cb) => respond(cb, { statusCode: 302, headers: {} }));
        await expect(safeFetchFeed('http://example.com/feed')).rejects.toThrow(/empty Location/);
    });

    it('gives up after too many redirects', async () => {
        allowPublicDns();
        mockRequest((cb) => respond(cb, {
            statusCode: 302,
            headers: { location: 'http://example.com/again' },
        }));

        await expect(safeFetchFeed('http://example.com/feed', 3)).rejects.toThrow(/Too many redirects/);
    });

    it('aborts a response that exceeds the size cap', async () => {
        allowPublicDns();
        // 6 MB against a 5 MB ceiling.
        const oversized = 'x'.repeat(1024 * 1024);
        mockRequest((cb) => respond(cb, { chunks: Array(6).fill(oversized) }));

        await expect(safeFetchFeed('http://example.com/feed')).rejects.toThrow(/exceeds maximum allowed size/);
    });

    it('surfaces a socket inactivity timeout', async () => {
        allowPublicDns();
        jest.spyOn(http, 'request').mockImplementation(() => {
            const req = new EventEmitter();
            req.destroy = jest.fn();
            req.end = () => setImmediate(() => req.emit('timeout'));
            return req;
        });

        await expect(safeFetchFeed('http://example.com/feed')).rejects.toThrow(/timed out/);
    });

    it('surfaces a request error', async () => {
        allowPublicDns();
        jest.spyOn(http, 'request').mockImplementation(() => {
            const req = new EventEmitter();
            req.destroy = jest.fn();
            req.end = () => setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
            return req;
        });

        await expect(safeFetchFeed('http://example.com/feed')).rejects.toThrow(/ECONNREFUSED/);
    });

    it('enforces a wall-clock deadline a trickling server cannot extend', async () => {
        jest.useFakeTimers();
        try {
            allowPublicDns();
            // Never emits 'end' and never goes idle long enough to trip the
            // socket timeout — exactly the shape the deadline exists for.
            jest.spyOn(http, 'request').mockImplementation((opts, cb) => {
                const req = new EventEmitter();
                req.destroy = jest.fn();
                req.end = () => {
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    res.headers = {};
                    res.destroy = jest.fn();
                    cb(res);
                };
                return req;
            });

            const pending = safeFetchFeed('http://slowloris.example/feed');
            const assertion = expect(pending).rejects.toThrow(/exceeded the 8000ms time limit/);
            await jest.advanceTimersByTimeAsync(8_001);
            await assertion;
        } finally {
            jest.useRealTimers();
        }
    });
});
