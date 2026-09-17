// Options for the per-route read limiters on /stats, /insights and the
// item-image reads.
//
// These routes are already covered by the router-wide read limiter, but that is
// the custom BoundedRateLimiter, and CodeQL's js/missing-rate-limiting query
// recognises a limiter only when it comes from a rate-limiting package — its
// RateLimitingMiddleware class has no heuristic for a custom one. So the shared
// limiter is invisible to it and it flags each of these handlers as performing
// authorization (checkGuildAccess) with nothing rate-limiting it.
//
// The fix is an express-rate-limit limiter placed before checkGuildAccess on
// those routes. Only the OPTIONS live here; the `rateLimit(...)` call itself is
// made in each route file, next to the route that uses it, because that is what
// lets CodeQL's routing model connect the limiter to the handler it guards — a
// limiter built behind a factory in another module is not traced to the route.
//
// Keyed by session (the routes place the limiter after checkAuth, so req.user is
// always set), never by IP, which is why the package's proxy/IP startup checks
// are switched off and no bounded key store is needed: the key set is the admins
// currently online.
function readRateLimitOptions(limit) {
    return {
        windowMs: 60 * 1000,
        limit,
        keyGenerator: req => `u:${req.user.id}`,
        standardHeaders: true,
        legacyHeaders: false,
        validate: false,
        handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down.' }),
    };
}

module.exports = { readRateLimitOptions };
