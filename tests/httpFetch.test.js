'use strict';

/**
 * The four things `src/utils/httpFetch.js` restores after the move off axios
 * (#932). Each of them was load-bearing at a call site, and each is the kind of
 * thing that fails silently: an error that reads "fetch failed" instead of
 * naming a refused address, a timeout that cuts off a working stream, a body
 * read whole before anyone checks how big it was.
 *
 * Driven against a real HTTP server rather than a mocked `fetch`, because the
 * whole point of this module is what happens between the request going out and
 * the body arriving — which a mock replaces rather than exercises.
 */

const http = require('http');
const { Readable } = require('stream');

const { request, fetchHeaders, bodyStream, readCapped, readCappedText } = require('../src/utils/httpFetch');

let server;
let base;
/** Set per test: `(req, res) => void`. */
let handler;

beforeAll(() => new Promise(resolve => {
    server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
    });
}));

afterAll(() => new Promise(resolve => server.close(resolve)));

describe('request', () => {
    test('is `fetch`: a non-2xx is a response, not a throw', async () => {
        handler = (_req, res) => { res.writeHead(503); res.end('busy'); };

        const response = await request(`${base}/`);

        expect(response.status).toBe(503);
        expect(await response.text()).toBe('busy');
    });

    test('names the reason a connection failed instead of "fetch failed"', async () => {
        // The point of the whole wrapper: outboundGuard's refusals, DNS
        // failures and resets all arrive as `TypeError: fetch failed` with the
        // sentence somebody needs to read hidden on `cause`.
        const closed = await new Promise(resolve => {
            const probe = http.createServer();
            probe.listen(0, '127.0.0.1', () => {
                const { port } = probe.address();
                probe.close(() => resolve(port));
            });
        });

        const error = await request(`http://127.0.0.1:${closed}/`).catch(err => err);

        expect(error.message).toMatch(/ECONNREFUSED/);
        expect(error.code).toBe('ECONNREFUSED');
    });

    test('`timeout` bounds the whole request, body included', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('start');   // headers and a byte, then silence
        };

        const error = await request(`${base}/`, { timeout: 60 })
            .then(response => response.text())
            .catch(err => err);

        expect(error.name).toBe('TimeoutError');
    });

    test('an explicit signal wins over `timeout`', async () => {
        handler = (_req, res) => res.end('ok');
        const controller = new AbortController();
        controller.abort(new Error('caller changed its mind'));

        await expect(request(`${base}/`, { timeout: 60, signal: controller.signal }))
            .rejects.toThrow('caller changed its mind');
    });
});

describe('fetchHeaders', () => {
    test('a body that takes longer than the timeout is not cut off', async () => {
        // The property the MCP transports and the SSE channel depend on: the
        // clock is on the wait for headers, and the body is the caller's to
        // bound (or, for a standing event stream, not to bound at all).
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.write('first');
            setTimeout(() => res.end('-last'), 120);
        };

        const response = await fetchHeaders(`${base}/`, { timeout: 40 });

        expect(await response.text()).toBe('first-last');
    });

    test('headers that never arrive are cut off, in the words axios used', async () => {
        handler = () => {};   // accepted, never answered

        await expect(fetchHeaders(`${base}/`, { timeout: 50 }))
            .rejects.toThrow('timeout of 50ms exceeded');
    });
});

describe('bodyStream', () => {
    test('reads as a Node stream, which is what every reader here expects', async () => {
        handler = (_req, res) => res.end('one\ntwo\n');

        const chunks = [];
        for await (const chunk of bodyStream(await request(`${base}/`))) chunks.push(chunk);

        expect(Buffer.isBuffer(chunks[0])).toBe(true);
        expect(Buffer.concat(chunks).toString()).toBe('one\ntwo\n');
    });

    test('destroying it releases the response rather than leaving it open', async () => {
        handler = (_req, res) => {
            res.writeHead(200);
            res.write('start');
            // Held open: only a cancel from the client ends this.
        };

        const response = await request(`${base}/`);
        const stream = bodyStream(response);
        stream.destroy();
        await new Promise(resolve => stream.on('close', resolve));

        expect(response.bodyUsed || response.body.locked).toBe(true);
    });

    test('stands an empty stream in for a response with no body at all', async () => {
        handler = (_req, res) => { res.writeHead(204); res.end(); };

        const chunks = [];
        for await (const chunk of bodyStream(await request(`${base}/`))) chunks.push(chunk);

        expect(chunks).toEqual([]);
    });
});

describe('readCapped', () => {
    test('hands back the whole body when it fits', async () => {
        handler = (_req, res) => res.end('small enough');

        expect(await readCappedText(await request(`${base}/`), 1024)).toBe('small enough');
    });

    test('refuses at the limit rather than buffering what arrives after it', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            Readable.from([Buffer.alloc(64 * 1024), Buffer.alloc(64 * 1024)]).pipe(res);
        };

        const error = await readCapped(await request(`${base}/`), 1024).catch(err => err);

        expect(error.code).toBe('ETOOLARGE');
        expect(error.message).toMatch(/exceeded 1024 bytes/);
    });

    // A chunked response declares no length, and a `Content-Length` is somebody
    // else's number in any case — so the cap has to count what actually lands.
    test('does not take the declared length as the answer', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-length': '4' });
            res.end(Buffer.alloc(4));
        };

        expect((await readCapped(await request(`${base}/`), 8)).length).toBe(4);
    });
});
