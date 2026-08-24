'use strict';

/**
 * SSRF guards for outbound HTTP that a *user* pointed at something.
 *
 * `safeFeedFetch.js` already does this for RSS, and does it by hand: it
 * resolves the hostname itself, checks every returned address, then connects to
 * the one it checked. That shape is right for a fetcher that owns its own
 * request loop and has to re-run the check on each redirect hop, and it stays
 * where it is.
 *
 * This module is the same guarantee for the requests the bot makes through a
 * client library — axios, an SDK — where the connection is not ours to build.
 * Rather than resolving up front and hoping the library connects to the same
 * address (it will not: it resolves again, and DNS can answer differently the
 * second time), the checks are moved to where the socket is opened: into the
 * resolver for hostnames, and into the agent's `createConnection` for literal
 * addresses, which never reach a resolver at all. The address that is validated
 * is by construction the address that is dialled, so there is no window between
 * the two for a rebind to land in — on the first request or on a redirect.
 *
 * `isPrivateIp` is imported from safeFeedFetch rather than copied: the list of
 * ranges that must never be reached is one rule, and two copies of it drift.
 */

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { isPrivateIp } = require('./safeFeedFetch');

// A URL's hostname keeps IPv6 in brackets; `net.isIP` and `isPrivateIp` do not.
function bareHost(host) {
    const text = String(host || '');
    return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

/**
 * The error for connecting to a literal address in private or reserved space,
 * or null when `host` is not a literal address at all.
 *
 * This exists because `guardedLookup` below is not enough on its own:
 * `net.connect` skips DNS entirely when the host is already an IP, so a lookup
 * hook never sees `http://169.254.169.254/` — which is the first address anyone
 * tries. Every literal therefore has to be checked where the socket is opened.
 */
function literalAddressError(host) {
    const address = bareHost(host);
    if (!net.isIP(address) || !isPrivateIp(address)) return null;
    const error = new Error(
        `Refusing to connect to ${address}: it is a private or reserved address.`
    );
    error.code = 'EPRIVATEADDR';
    return error;
}

/**
 * A `dns.lookup` drop-in that refuses to resolve to private or reserved space.
 *
 * Node hands `lookup` to `net.connect` with whatever shape the caller used, and
 * expects the matching shape back: an array when it asked for `all` (which
 * Happy Eyeballs does by default since Node 20), a single address otherwise.
 * Both are handled, and the underlying query always asks for every address so
 * that a hostname answering with one public and one private address is refused
 * rather than being allowed on whichever the resolver happened to order first.
 */
function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {}
        : typeof options === 'number' ? { family: options }
        : options || {};

    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return cb(err);

        const list = Array.isArray(addresses) ? addresses : [addresses];
        if (!list.length) return cb(new Error(`"${hostname}" resolved to no addresses.`));

        const blocked = list.find(entry => isPrivateIp(entry.address));
        if (blocked) {
            const error = new Error(
                `Refusing to connect to "${hostname}": it resolves to ${blocked.address}, ` +
                'which is a private or reserved address.'
            );
            error.code = 'EPRIVATEADDR';
            return cb(error);
        }

        if (opts.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

// Two checks per connection, because they cover different inputs: `lookup`
// handles hostnames, and the override handles the literal addresses `lookup`
// never sees. `createConnection` is where a connection is actually opened, so a
// redirect to a private address is checked exactly like the first request was —
// which is what makes this hold for a library whose redirect handling we do not
// write.
function guardConnection(agentClass) {
    return class GuardedAgent extends agentClass {
        createConnection(options, callback) {
            const error = literalAddressError(options.host ?? options.hostname);
            if (!error) return super.createConnection(options, callback);
            // Reporting through the callback rather than throwing keeps the
            // failure on the request, where a caller can catch it, instead of
            // unwinding through the agent's internals.
            process.nextTick(() => callback(error));
            return undefined;
        }
    };
}

const GuardedHttpAgent = guardConnection(http.Agent);
const GuardedHttpsAgent = guardConnection(https.Agent);

// One pair for the process. Agents are pooled by design and these carry no
// per-request state; keepAlive is left off (the default), so no socket outlives
// the request that validated its address.
let agents = null;

/**
 * `{ httpAgent, httpsAgent }` for handing to axios (or any library that takes
 * Node agents).
 */
function guardedAgents() {
    if (!agents) {
        agents = {
            httpAgent: new GuardedHttpAgent({ lookup: guardedLookup }),
            httpsAgent: new GuardedHttpsAgent({ lookup: guardedLookup }),
        };
    }
    return agents;
}

/**
 * Parses a user-supplied URL and throws unless it is a plain http(s) address.
 *
 * Rejected here: anything that is not a URL at all, schemes that are not
 * http/https (file:, gopher:, redis:), embedded credentials — which no
 * legitimate configured endpoint needs and which exist mostly to smuggle a host
 * past a naive parser — and a literal address in private or reserved space.
 *
 * Where a *hostname* points is not settled here, because it is not knowable
 * when a setting is saved; that is what the agents above are for.
 *
 * @returns {URL} the parsed URL, so callers can use the normalised form.
 */
function assertPublicHttpUrl(raw, label = 'URL') {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) throw new Error(`${label} must be a non-empty URL.`);
    if (text.length > 512) throw new Error(`${label} is too long (max 512 characters).`);

    let url;
    try {
        url = new URL(text);
    } catch {
        throw new Error(`${label} is not a valid URL.`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${label} must use http:// or https:// (got "${url.protocol}//").`);
    }
    if (url.username || url.password) {
        throw new Error(`${label} must not embed credentials.`);
    }
    if (!url.hostname) {
        throw new Error(`${label} must include a hostname.`);
    }

    // A literal address is the one case where the destination *is* knowable now,
    // and it is also the common one: 169.254.169.254 and 127.0.0.1 are typed
    // directly, not resolved. Saying so when the value is saved beats accepting
    // it and refusing every request it produces.
    const literal = literalAddressError(url.hostname);
    if (literal) throw new Error(`${label}: ${literal.message}`);

    return url;
}

module.exports = { guardedLookup, guardedAgents, assertPublicHttpUrl, literalAddressError };
