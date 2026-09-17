// Shared Express middleware for the dashboard API routes.

const { hasManagePermission, verifyLiveGuildAccess } = require('./permissions');
const { BoundedRateLimiter } = require('../../utils/boundedRateLimiter');

const WRITE_RL_WINDOW_MS = 60 * 1000;
const WRITE_RL_LIMIT = 60;
const writeRateLimiter = new BoundedRateLimiter(10_000);
// Clean up stale entries every minute (was every 5 min — tightened to reduce memory growth window)
setInterval(() => writeRateLimiter.cleanup(WRITE_RL_WINDOW_MS), 60 * 1000).unref();

// Reads were unlimited on the assumption that a GET is cheap. Several are not:
// /stats and /insights each run collection-wide aggregations over a guild's users
// and hydrate a thousand moderation cases, so an authenticated admin looping them
// costs the bot far more than it costs the caller — and the container has 1 GB.
// The ceiling is deliberately well above what the dashboard itself asks for; a
// page load fires a handful of GETs, not a hundred.
const READ_RL_WINDOW_MS = 60 * 1000;
const READ_RL_LIMIT = 120;
const readRateLimiter = new BoundedRateLimiter(10_000);
setInterval(() => readRateLimiter.cleanup(READ_RL_WINDOW_MS), 60 * 1000).unref();

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// Two gates, in cost order.
//
// The first is the session's own guild list, which is free to read and rejects
// every request from someone who never administered this guild. The second asks
// Discord whether they still do (#558): that list was captured once, at OAuth
// time, and `maxAge` is the only thing that ever retires it, so on its own it
// hands a demoted or kicked admin full write access until their cookie expires.
//
// `verifyLiveGuildAccess` answers null when nobody could say — a Discord
// outage, a gateway that predates the method — and null falls through to the
// snapshot rather than to a 403, because the alternative is that an unrelated
// Discord incident locks every operator out of their own dashboard. That is a
// deliberate soft edge on the *unknown* answer only; a definite `false` denies.
async function checkGuildAccess(req, res, next) {
    const { guildId } = req.params;
    // One call for the whole list rather than one per guild: the facade may be
    // another process now (src/bot/remoteGateway.js), and a user in fifty
    // servers would otherwise cost fifty round trips per request.
    const manageable = req.user.guilds.filter(hasManagePermission);
    const present = await req.bot.hasGuilds(manageable.map(g => g.id));
    const userGuilds = manageable.filter(guild => present[guild.id]);

    if (!userGuilds.find(g => g.id === guildId)) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (await verifyLiveGuildAccess(req.bot, guildId, req.user.id) === false) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    next();
}

function checkWriteRateLimit(req, res, next) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!writeRateLimiter.check(userId, WRITE_RL_WINDOW_MS, WRITE_RL_LIMIT)) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
}

// Counted per session where there is one, per address otherwise. Unauthenticated
// callers are not rejected here — the routes' own checkAuth answers that, and
// doing it in the limiter would only change which status code a scanner sees.
function checkReadRateLimit(req, res, next) {
    const key = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
    if (!readRateLimiter.check(key, READ_RL_WINDOW_MS, READ_RL_LIMIT)) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
}

// M2: CSRF origin validation for all state-changing API requests, applied
// router-wide in routes/api.js. Complements sameSite: 'lax' cookies — a
// POST/PUT/DELETE is admitted only when the browser says, one way or another,
// that it came from the dashboard's own origin.
function checkCsrfOrigin(req, res, next) {
    const reject = () => res.status(403).json({ error: 'Forbidden: cross-origin request rejected' });
    const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`;

    const origin = req.headers.origin;
    if (origin) {
        try {
            if (new URL(origin).origin === new URL(dashboardUrl).origin) return next();
        } catch { /* unparseable Origin — fall through to reject */ }
        return reject();
    }

    // No Origin at all. This used to be waved through (#563), which made the
    // header check fail open: with no CSRF token anywhere in the dashboard, a
    // request that simply omits Origin was accepted on nothing but SameSite=Lax.
    //
    // Nothing is lost by refusing. The Fetch standard requires a browser to
    // send Origin on every request whose method is not GET or HEAD, and this
    // middleware only runs on those methods (see routes/api.js) — so a real
    // browser write always carries one. Fetch Metadata is accepted as the
    // fallback for the same reason it exists: `same-origin` and `none` (a
    // user-typed URL or a bookmark) are both statements the *browser* makes and
    // a cross-site page cannot forge. Everything else — a stray proxy, a
    // scripted client, an old browser sending neither header — is refused
    // rather than trusted by default.
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-origin' || site === 'none') return next();
    return reject();
}

// `checkAnyGuildAdmin` — "an admin of any guild the bot is in" — used to live
// here, and the two routes that used it were the cross-tenant write in #561.
// It is gone with them: on a multi-tenant dashboard there is no request whose
// correct authorization is "administers something, somewhere", and leaving the
// helper in place is an invitation for the next route to reach for it.

module.exports = { checkAuth, checkGuildAccess, checkWriteRateLimit, checkReadRateLimit, checkCsrfOrigin };
