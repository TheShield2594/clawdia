// Shared Express middleware for the dashboard API routes.

// Bounded in-memory rate limiter.
// Uses a Map (insertion-order preserved) so that when the map is full the oldest
// entry is evicted first — giving FIFO/LRU behaviour without a separate library.
// Max size of 10 000 entries prevents memory exhaustion even under sustained
// enumeration attacks using unique fake user IDs.
class BoundedRateLimiter {
    constructor(maxSize = 10_000) {
        this._map = new Map();
        this._maxSize = maxSize;
    }

    check(userId, windowMs, limit) {
        const now = Date.now();
        const arr = (this._map.get(userId) || []).filter(t => now - t < windowMs);
        if (arr.length >= limit) {
            this._map.set(userId, arr); // refresh pruned array
            return false;
        }
        // Evict oldest entry before inserting a new key
        if (!this._map.has(userId) && this._map.size >= this._maxSize) {
            this._map.delete(this._map.keys().next().value);
        }
        arr.push(now);
        this._map.set(userId, arr);
        return true;
    }

    cleanup(windowMs) {
        const cutoff = Date.now() - windowMs;
        for (const [userId, timestamps] of this._map) {
            if (timestamps.every(t => t < cutoff)) this._map.delete(userId);
        }
    }
}

const WRITE_RL_WINDOW_MS = 60 * 1000;
const WRITE_RL_LIMIT = 60;
const writeRateLimiter = new BoundedRateLimiter(10_000);
// Clean up stale entries every minute (was every 5 min — tightened to reduce memory growth window)
setInterval(() => writeRateLimiter.cleanup(WRITE_RL_WINDOW_MS), 60 * 1000).unref();

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function checkGuildAccess(req, res, next) {
    const { guildId } = req.params;
    const userGuilds = req.user.guilds.filter(guild =>
        (guild.permissions & 0x20) === 0x20 && req.client.guilds.cache.has(guild.id)
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
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x20) === 0x20 && req.client.guilds.cache.has(g.id));
    if (!adminGuilds.length) return res.status(403).json({ error: 'Forbidden' });
    next();
}

module.exports = { checkAuth, checkGuildAccess, checkWriteRateLimit, checkCsrfOrigin, checkAnyGuildAdmin };
