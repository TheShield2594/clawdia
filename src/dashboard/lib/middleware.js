// Shared Express middleware for the dashboard API routes.

const { hasManagePermission } = require('./permissions');
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

function checkGuildAccess(req, res, next) {
    const { guildId } = req.params;
    const userGuilds = req.user.guilds.filter(guild =>
        hasManagePermission(guild) && req.client.guilds.cache.has(guild.id)
    );

    if (!userGuilds.find(g => g.id === guildId)) {
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

// M2: CSRF origin validation for all state-changing API requests.
// Complements sameSite: 'lax' cookies — rejects cross-origin POST/PUT/DELETE that
// carry an Origin header pointing to a different host than the dashboard.
function checkCsrfOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next(); // same-origin requests may omit Origin
    const dashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`;
    try {
        if (new URL(origin).origin === new URL(dashboardUrl).origin) return next();
    } catch { /* fall through to reject */ }
    return res.status(403).json({ error: 'Forbidden: cross-origin request rejected' });
}

function checkAnyGuildAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const adminGuilds = req.user.guilds.filter(g => hasManagePermission(g) && req.client.guilds.cache.has(g.id));
    if (!adminGuilds.length) return res.status(403).json({ error: 'Forbidden' });
    next();
}

module.exports = { checkAuth, checkGuildAccess, checkWriteRateLimit, checkReadRateLimit, checkCsrfOrigin, checkAnyGuildAdmin };
