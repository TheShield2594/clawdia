/**
 * SSRF-safe feed fetcher.
 *
 * RSS/Atom feed URLs are operator-supplied through the dashboard, so every
 * fetch of one is an outbound request whose destination an authenticated guild
 * admin controls. Without this guard a feed URL pointing at 169.254.169.254,
 * the internal MongoDB host, or any other service reachable from the bot
 * container would be fetched and its body relayed into a Discord channel.
 *
 * This module is the single entry point for fetching feed content. Both the
 * dashboard's validate-feed endpoint and the scheduled rssService poller must
 * go through `safeFetchFeed` — fetching a feed URL any other way (for example
 * rss-parser's own `parseURL`) bypasses every check below.
 */

// Two independent limits per hop. SOCKET_IDLE_MS is Node's inactivity timeout,
// which a server can reset indefinitely by trickling bytes; HOP_DEADLINE_MS is
// the wall-clock ceiling that a trickle cannot extend.
const SOCKET_IDLE_MS = 8000;
const HOP_DEADLINE_MS = 8000;

// Identifies the bot to the feed host. This module serves the scheduled poller
// as much as the dashboard's validate button, so the old
// "Clawdia-FeedValidator/1.0" both misdescribed most of its own traffic and
// read to a bot filter as an unattributed scraper — and a feed that answers a
// browser but 403s this string is a feed that silently stops posting. A name
// and a URL is what a well-behaved reader sends.
const FEED_USER_AGENT = 'Clawdia/1.0 (+https://github.com/TheShield2594/clawdia; Discord RSS reader)';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');


// Returns true for an IPv4 address that must not be fetched: loopback, RFC1918,
// link-local, CGNAT, multicast and every IANA special-purpose block that is not
// globally routable (RFC 6890).
function isPrivateIpv4(ip) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
        a === 0 ||                              // this-network 0.0.0.0/8
        a === 127 ||                            // loopback
        a === 10 ||                             // RFC1918 /8
        (a === 100 && b >= 64 && b <= 127) ||   // RFC 6598 shared address space
        (a === 172 && b >= 16 && b <= 31) ||    // RFC1918 /12
        (a === 192 && b === 168) ||             // RFC1918 /16
        (a === 169 && b === 254) ||             // link-local
        (a === 192 && b === 0 && c === 0) ||    // IETF protocol assignments 192.0.0.0/24
        (a === 192 && b === 0 && c === 2) ||    // documentation TEST-NET-1
        (a === 192 && b === 88 && c === 99) ||  // 6to4 relay anycast (RFC 7526)
        (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
        (a === 198 && b === 51 && c === 100) || // documentation TEST-NET-2
        (a === 203 && b === 0 && c === 113) ||  // documentation TEST-NET-3
        (a >= 224 && a <= 239) ||               // multicast 224.0.0.0/4
        a >= 240                                // reserved/broadcast 240.0.0.0/4 + 255.255.255.255
    );
}

// Expands a valid IPv6 string into its eight 16-bit groups, so prefix checks
// compare numbers instead of text. String prefixes miss equivalent spellings:
// `::127.0.0.1` normalises to `::7f00:1`, and `0:0::1` is `::1`.
function ipv6Groups(ip) {
    let s = ip.toLowerCase();
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    // A dotted IPv4 tail (`::ffff:1.2.3.4`) stands for the last two groups.
    const tail = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (tail) {
        const [, p, q, r, t] = tail.map(Number);
        s = `${s.slice(0, tail.index)}${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
    }
    const [head, rest] = s.split('::');
    const left = head ? head.split(':') : [];
    const right = rest === undefined ? [] : (rest ? rest.split(':') : []);
    const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0');
    return [...left, ...fill, ...right].map(h => parseInt(h, 16));
}

// The IPv4 address carried in two IPv6 groups.
function groupsToIpv4(hi, lo) {
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Returns true for any IP that must not be fetched (loopback, RFC1918, link-local, IPv6 ULA/LL, etc.).
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) return isPrivateIpv4(ip);
    if (net.isIPv6(ip)) {
        const g = ipv6Groups(ip);
        if (g.length !== 8 || g.some(n => !Number.isInteger(n))) return true;
        const zeroUpTo = n => g.slice(0, n).every(x => x === 0);
        return (
            zeroUpTo(6) ||                                          // ::/96: ::, ::1 and IPv4-compatible ::a.b.c.d
            (zeroUpTo(5) && g[5] === 0xffff) ||                     // IPv4-mapped ::ffff:0:0/96
            (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) ||       // IPv4-translated ::ffff:0:0:0/96 (RFC 2765)
            (g[0] === 0x64 && g[1] === 0xff9b) ||                   // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
            (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) || // discard prefix 100::/64 (RFC 6666)
            (g[0] === 0x2001 && g[1] === 0) ||                      // Teredo 2001::/32, which tunnels to an embedded IPv4
            (g[0] === 0x2001 && g[1] === 0x2 && g[2] === 0) ||      // benchmarking 2001:2::/48 (RFC 5180)
            (g[0] === 0x2001 && g[1] === 0xdb8) ||                  // documentation 2001:db8::/32 (RFC 3849)
            (g[0] === 0x3fff && (g[1] & 0xf000) === 0) ||           // documentation 3fff::/20 (RFC 9637)
            (g[0] === 0x2002 && isPrivateIpv4(groupsToIpv4(g[1], g[2]))) || // 6to4 2002::/16 wrapping a private IPv4
            (g[0] & 0xfe00) === 0xfc00 ||                           // ULA fc00::/7
            (g[0] & 0xffc0) === 0xfe80 ||                           // link-local fe80::/10
            (g[0] & 0xffc0) === 0xfec0 ||                           // deprecated site-local fec0::/10
            (g[0] & 0xff00) === 0xff00                              // multicast ff00::/8
        );
    }
    return true; // unknown format — block by default
}

// Rejects if `promise` has not settled within `ms`.
//
// The timer is unref'd so a pending deadline never by itself holds the process
// open; whatever operation is being raced keeps the event loop alive on its own.
function withDeadline(promise, ms, message) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Resolves a hostname to all its IP addresses, validates none are private, and returns
// the first address to use as a pinned IP for the actual TCP connection.
// Pinning prevents DNS rebinding: the IP checked here is the IP we connect to.
async function resolveAndPin(hostname, allowPrivate = false) {
    // dns.lookup has no timeout of its own — it calls getaddrinfo on the libuv
    // threadpool and waits for the system resolver, which against an unreachable
    // nameserver can mean tens of seconds. That happens before the request
    // deadline below is armed, so without this a hop could stall well past its
    // budget, and a chain of redirects multiplies it. The blocked threadpool slot
    // is the worse half: there are four by default, shared with fs and crypto.
    //
    // getaddrinfo is not cancellable, so this only unblocks the caller — the
    // underlying lookup runs to completion in the background.
    const addrs = await withDeadline(new Promise((resolve, reject) => {
        dns.lookup(hostname, { all: true }, (err, results) => {
            if (err) reject(new Error(`DNS lookup failed: ${err.message}`));
            else resolve(results);
        });
    }), HOP_DEADLINE_MS, `DNS lookup for "${hostname}" exceeded ${HOP_DEADLINE_MS}ms.`);

    if (!addrs.length) throw new Error('Hostname resolved to no addresses.');
    // `allowPrivate` is only ever true for the one caller-supplied origin the
    // request has already matched (the configured social bridge); every other
    // hostname is still refused if any of its addresses is private, so a
    // rebind that lands on a private address remains blocked.
    for (const { address } of addrs) {
        if (!allowPrivate && isPrivateIp(address)) throw new Error('Feed URL resolves to a private or reserved IP address.');
    }
    return addrs[0].address; // pinned IP used for the actual connection
}

// Fetches a feed URL safely: pins DNS on every hop, follows redirects up to
// maxRedirects. Returns the response body as a string.
//
// `options` is `{ maxRedirects = 5, allowPrivateOrigin }`, and for backward
// compatibility a bare number is still accepted as maxRedirects.
//
// `allowPrivateOrigin` names a single origin (the operator-configured social
// bridge, SOCIAL_BRIDGE_BASE_URL — typically a container on the bot's own Docker
// network) whose resolution to a private/reserved address is permitted. The
// relaxation is deliberately narrow: it applies only on a hop whose origin
// exactly matches it, re-checked each hop, so an operator-supplied feed URL is
// unaffected and a redirect from the bridge to any other origin — a metadata
// endpoint, an internal host — is still blocked. DNS pinning and the TLS/cert
// validation below are untouched.
async function safeFetchFeed(urlStr, options = {}) {
    const opts = typeof options === 'number' ? { maxRedirects: options } : (options || {});
    return (await fetchFeedResponse(urlStr, { ...opts, validators: null })).body;
}

// A cache validator as the server sent it, or null for anything that should
// not be echoed back in a request header: missing, oversized, or carrying a
// control character (which Node would refuse to send anyway, as a throw).
function cleanValidator(value) {
    if (typeof value !== 'string' || !value || value.length > 512) return null;
    // eslint-disable-next-line no-control-regex
    return /[\x00-\x1f\x7f]/.test(value) ? null : value;
}

/**
 * Fetch a feed conditionally. `validators` is what a previous fetch of the same
 * URL returned — `{ etag, lastModified }` — and is sent as If-None-Match /
 * If-Modified-Since. A feed that has not changed answers 304 with no body, and
 * this resolves `{ notModified: true }` without downloading or parsing
 * anything. Otherwise it resolves `{ body, validators }`, the latter to hand
 * back on the next call (null when the server sent neither header).
 *
 * Same guarantees as safeFetchFeed; `options` is the same shape.
 */
async function fetchFeedConditional(urlStr, validators, options = {}) {
    const result = await fetchFeedResponse(urlStr, { ...options, validators: validators || null });
    if (result.notModified) return { notModified: true };
    const etag = cleanValidator(result.etag);
    const lastModified = cleanValidator(result.lastModified);
    return { body: result.body, validators: etag || lastModified ? { etag, lastModified } : null };
}

async function fetchFeedResponse(urlStr, opts) {
    const tls = require('tls');
    const maxRedirects = Number.isInteger(opts.maxRedirects) ? opts.maxRedirects : 5;

    let allowedOrigin = null;
    if (opts.allowPrivateOrigin) {
        try { allowedOrigin = new URL(opts.allowPrivateOrigin).origin; } catch { allowedOrigin = null; }
    }

    let current = new URL(urlStr);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        if (!['http:', 'https:'].includes(current.protocol)) {
            throw new Error('Redirect to non-HTTP protocol rejected.');
        }

        // Resolve DNS once, validate all returned IPs, then pin to avoid
        // rebinding. The private-address check is relaxed only when this hop's
        // origin is the permitted bridge origin.
        const allowPrivate = allowedOrigin !== null && current.origin === allowedOrigin;
        const pinnedIp = await resolveAndPin(current.hostname, allowPrivate);
        const port = current.port ? Number(current.port) : (current.protocol === 'https:' ? 443 : 80);
        const FEED_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — enough for any real RSS feed

        const result = await new Promise((resolve, reject) => {
            // `timeout` below is a socket *inactivity* timeout: it only fires
            // when nothing arrives for that long. A server that drips a byte
            // every few seconds resets it forever, so a hop needs a hard
            // wall-clock deadline on top of it. Both are armed; whichever trips
            // first ends the hop.
            let settled = false;
            let deadlineTimer = null;
            const finish = (fn) => (value) => {
                if (settled) return;
                settled = true;
                if (deadlineTimer) {
                    clearTimeout(deadlineTimer);
                    deadlineTimer = null;
                }
                fn(value);
            };
            const succeed = finish(resolve);
            const fail = finish(reject);

            const commonHeaders = {
                'User-Agent': FEED_USER_AGENT,
                Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
                // Nothing here decompresses, and a server that gzips anyway
                // would hand the parser binary and be reported as malformed
                // XML. Asking for identity is the difference between a feed
                // that fails for a stated reason and one that fails for none.
                'Accept-Encoding': 'identity',
                Host: current.hostname, // required when connecting directly to a pinned IP
            };
            const etag = cleanValidator(opts.validators?.etag);
            const lastModified = cleanValidator(opts.validators?.lastModified);
            if (etag) commonHeaders['If-None-Match'] = etag;
            if (lastModified) commonHeaders['If-Modified-Since'] = lastModified;

            let req;
            if (current.protocol === 'https:') {
                // For HTTPS: connect to the pinned IP but validate the TLS cert against
                // the original hostname (SNI + checkServerIdentity).
                req = https.request({
                    hostname: current.hostname,
                    port,
                    path: current.pathname + current.search,
                    method: 'GET',
                    headers: commonHeaders,
                    timeout: SOCKET_IDLE_MS,
                    createConnection: (opts, cb) => tls.connect({
                        host: pinnedIp,
                        port,
                        servername: current.hostname,
                        rejectUnauthorized: true,
                    }, cb),
                }, handleResponse);
            } else {
                req = http.request({
                    hostname: pinnedIp, // connect to pinned IP directly
                    port,
                    path: current.pathname + current.search,
                    method: 'GET',
                    headers: commonHeaders,
                    timeout: SOCKET_IDLE_MS,
                }, handleResponse);
            }

            function handleResponse(res) {
                // Only meaningful as an answer to a conditional request; a 304
                // to a request that sent no validator falls through and fails
                // as the non-2xx it is.
                if (res.statusCode === 304 && (etag || lastModified)) {
                    res.destroy();
                    return succeed({ notModified: true });
                }

                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const loc = res.headers.location;
                    res.destroy();
                    return succeed({ redirect: loc });
                }

                // A non-2xx body is not a feed, and handing it to the parser
                // anyway is how "the host is refusing us" was reported as
                // "Feed not recognized as RSS 1 or 2". The status is the whole
                // diagnosis — a 403 from a bot filter, a 404 for a feed that
                // moved, a 429 to back off from — so it goes in the message
                // rather than being replaced by a parser error downstream.
                if (res.statusCode < 200 || res.statusCode > 299) {
                    const status = res.statusCode;
                    res.destroy();
                    return fail(new Error(`Feed request failed with HTTP ${status}.`));
                }

                const chunks = [];
                let totalBytes = 0;
                res.on('data', c => {
                    totalBytes += c.length;
                    if (totalBytes > FEED_MAX_BYTES) {
                        res.destroy();
                        return fail(new Error('Feed response exceeds maximum allowed size (5 MB).'));
                    }
                    chunks.push(c);
                });
                res.on('end', () => succeed({
                    body: Buffer.concat(chunks).toString('utf8'),
                    etag: res.headers.etag,
                    lastModified: res.headers['last-modified'],
                }));
                res.on('error', fail);
            }

            deadlineTimer = setTimeout(() => {
                req.destroy();
                fail(new Error(`Feed request exceeded the ${HOP_DEADLINE_MS}ms time limit.`));
            }, HOP_DEADLINE_MS);

            req.on('timeout', () => { req.destroy(); fail(new Error('Feed request timed out.')); });
            req.on('error', fail);
            req.end();
        });

        // Tested for presence, not truthiness: a 3xx with no Location header
        // resolves to { redirect: undefined }, which a truthiness check treats as
        // "not a redirect" and falls through to `return result.body` — handing
        // back undefined instead of raising, and leaving the guard below
        // unreachable.
        if ('redirect' in result) {
            if (typeof result.redirect !== 'string' || !result.redirect.trim()) {
                throw new Error('Redirect with empty Location header.');
            }
            current = new URL(result.redirect, current.href);
            continue;
        }
        return result;
    }
    throw new Error('Too many redirects.');
}

module.exports = { safeFetchFeed, fetchFeedConditional, isPrivateIp, resolveAndPin };
