'use strict';

// Which peers the dashboard believes about `X-Forwarded-For` (#1161).
//
// Express's `trust proxy` decides what `req.ip` and `req.protocol` are. The
// per-IP rate limits key on `req.ip`, and the session cookie is `secure` in
// production, which only works when Express believes the proxy that says the
// request arrived over HTTPS. It used to be `1` whenever NODE_ENV=production:
// right behind a reverse proxy, and wrong for a production deploy with none,
// where the first hop *is* the client and a forged `X-Forwarded-For` became its
// address — every per-IP limit bypassed by sending a new header each time.
//
// TRUST_PROXY makes it a setting:
//
//   unset        production: the private ranges (`loopback, linklocal,
//                uniquelocal`) — a proxy on the same host or Docker network is
//                believed, a client arriving from a public address is not.
//                Otherwise: nothing is trusted.
//   false / 0    trust nothing; `req.ip` is the socket peer.
//   <number>     trust that many hops, e.g. `1` for a proxy on a public
//                address (a separate VM, a CDN) in front of the dashboard.
//   <list>       comma-separated addresses, CIDRs or Express's names
//                (`loopback`, `linklocal`, `uniquelocal`).
//
// `true` (trust every hop) is refused: it is the setting that believes a
// header the client wrote, which is exactly the bug.

const PRIVATE_RANGES = 'loopback, linklocal, uniquelocal';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ value: false | number | string }}
 */
function resolveTrustProxy(env = process.env) {
    const raw = String(env.TRUST_PROXY ?? '').trim();
    if (!raw) {
        return env.NODE_ENV === 'production'
            ? { value: PRIVATE_RANGES }
            : { value: false };
    }
    const lower = raw.toLowerCase();
    if (['false', 'no', 'off', 'none', '0'].includes(lower)) return { value: false };
    if (lower === 'true') {
        throw new Error('TRUST_PROXY=true would trust an X-Forwarded-For written by the client itself. '
            + 'Set the number of proxy hops (usually 1) or the proxy addresses instead.');
    }
    if (/^\d+$/.test(raw)) return { value: Number(raw) };
    return { value: raw };
}

module.exports = { resolveTrustProxy, PRIVATE_RANGES };
