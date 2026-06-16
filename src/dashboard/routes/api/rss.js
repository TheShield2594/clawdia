const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const Parser = require('rss-parser');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId } = require('../../lib/apiHelpers');
const { rescheduleDailyNews, sendDailyNews } = require('../../../services/rssService');

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

// Resolves a hostname to all its IP addresses, validates none are private, and returns
// the first address to use as a pinned IP for the actual TCP connection.
// Pinning prevents DNS rebinding: the IP checked here is the IP we connect to.
async function resolveAndPin(hostname) {
    const addrs = await new Promise((resolve, reject) => {
        dns.lookup(hostname, { all: true }, (err, results) => {
            if (err) reject(new Error(`DNS lookup failed: ${err.message}`));
            else resolve(results);
        });
    });
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
            const commonHeaders = {
                'User-Agent': 'Clawdia-FeedValidator/1.0',
                Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
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
                    timeout: 8000,
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
                    timeout: 8000,
                }, handleResponse);
            }

            function handleResponse(res) {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const loc = res.headers.location;
                    res.destroy();
                    return resolve({ redirect: loc });
                }
                const chunks = [];
                let totalBytes = 0;
                res.on('data', c => {
                    totalBytes += c.length;
                    if (totalBytes > FEED_MAX_BYTES) {
                        res.destroy();
                        return reject(new Error('Feed response exceeds maximum allowed size (5 MB).'));
                    }
                    chunks.push(c);
                });
                res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
                res.on('error', reject);
            }

            req.on('timeout', () => { req.destroy(); reject(new Error('Feed request timed out.')); });
            req.on('error', reject);
            req.end();
        });

        if (result.redirect) {
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

router.post('/guild/:guildId/validate-feed', checkAuth, checkGuildAccess, async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ valid: false, error: 'No URL provided.' });
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.json({ valid: false, error: 'Invalid URL format.' });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.json({ valid: false, error: 'URL must use http or https.' });
    }

    try {
        const body = await safeFetchFeed(url);
        const feedParser = new Parser();
        const feed = await feedParser.parseString(body);
        return res.json({ valid: true, title: feed.title || '', itemCount: feed.items?.length ?? 0 });
    } catch (err) {
        return res.json({ valid: false, error: err.message || 'Could not fetch or parse feed. Check the URL and ensure it is a valid RSS/Atom feed.' });
    }
});

router.post('/guild/:guildId/rss/add', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { url, channelId } = req.body;

    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    if (!channelId || !isValidDiscordId(channelId)) return res.status(400).json({ error: 'channelId must be a valid Discord snowflake' });

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return res.status(400).json({ error: 'url must be a valid URL' });
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: 'url must use http or https' });
    }

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild not found' });

        guildSettings.rssFeeds.push({ url: url.trim(), channelId });
        await guildSettings.save();

        res.json({ success: true });
    } catch (error) {
        console.error('RSS add error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const dailyNewsInFlight = new Set();
router.post('/guild/:guildId/dailynews/trigger', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    if (dailyNewsInFlight.has(guildId)) {
        return res.status(409).json({ error: 'A digest is already being sent for this guild. Please wait for it to finish.' });
    }
    dailyNewsInFlight.add(guildId);
    try {
        await sendDailyNews(req.client, guildId);
        res.json({ success: true });
    } catch (error) {
        console.error('Daily news manual trigger error:', error);
        res.status(500).json({ error: 'Failed to send daily news. Check that the digest is configured.' });
    } finally {
        dailyNewsInFlight.delete(guildId);
    }
});

router.delete('/guild/:guildId/rss/:index', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, index } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId });

        guildSettings.rssFeeds.splice(parseInt(index), 1);
        await guildSettings.save();

        res.json({ success: true });
    } catch (error) {
        console.error('RSS delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
