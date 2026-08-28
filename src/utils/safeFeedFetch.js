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


// Returns true for any IP that must not be fetched (loopback, RFC1918, link-local, IPv6 ULA/LL, etc.).
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return (
            a === 0 ||
            a === 127 ||
            a === 10 ||
            (a === 100 && b >= 64 && b <= 127) || // RFC 6598 shared address space
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||            // link-local
            (a >= 224 && a <= 239) ||              // multicast 224.0.0.0/4
            a >= 240                               // reserved/broadcast 240.0.0.0/4 + 255.255.255.255
        );
    }
    if (net.isIPv6(ip)) {
        const n = ip.toLowerCase();
        return (
            n === '::1' ||                         // loopback
            n === '::' ||                          // unspecified
            n.startsWith('fc') ||                  // ULA fc00::/7
            n.startsWith('fd') ||                  // ULA fd00::/8
            /^fe[89ab]/i.test(n) ||                // link-local fe80::/10
            n.startsWith('ff') ||                  // multicast ff00::/8
            n.startsWith('::ffff:') ||             // IPv4-mapped ::ffff:0:0/96
            n.startsWith('::ffff:0:') ||           // IPv4-translated (RFC 2765)
            n.startsWith('64:ff9b:') ||            // IPv4-IPv6 translation (RFC 6052)
            n.startsWith('2001:db8:') ||           // documentation (RFC 3849)
            n.startsWith('100::')                  // discard prefix (RFC 6666)
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
async function resolveAndPin(hostname) {
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
    for (const { address } of addrs) {
        if (isPrivateIp(address)) throw new Error('Feed URL resolves to a private or reserved IP address.');
    }
    return addrs[0].address; // pinned IP used for the actual connection
}

// Fetches a feed URL safely: pins DNS on every hop, follows redirects up to maxRedirects.
// Returns the response body as a string.
async function safeFetchFeed(urlStr, maxRedirects = 5) {
    const tls = require('tls');
    let current = new URL(urlStr);

    for (let hop = 0; hop <= maxRedirects; hop++) {
        if (!['http:', 'https:'].includes(current.protocol)) {
            throw new Error('Redirect to non-HTTP protocol rejected.');
        }

        // Resolve DNS once, validate all returned IPs, then pin to avoid rebinding.
        const pinnedIp = await resolveAndPin(current.hostname);
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
                res.on('end', () => succeed({ body: Buffer.concat(chunks).toString('utf8') }));
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
        return result.body;
    }
    throw new Error('Too many redirects.');
}

module.exports = { safeFetchFeed, isPrivateIp, resolveAndPin };
