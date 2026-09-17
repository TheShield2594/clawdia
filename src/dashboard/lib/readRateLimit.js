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
// The fix is an express-rate-limit limiter mounted with router.use() ahead of
// those routes — the form CodeQL's routing model connects to the handlers it
// guards. Only the OPTIONS live here; the `rateLimit(...)` call itself is made in
// each route file, next to the router.use that installs it, so the source and its
// installation stay local.
//
// router.use runs before the route's checkAuth, so an unauthenticated request
// reaches the limiter with no req.user: it is keyed by session where there is one
// and by address otherwise (the same scheme the shared read limiter uses), and
// the package's proxy/IP startup checks are switched off because the key is built
// by hand.
function readRateLimitOptions(limit) {
    return {
        windowMs: 60 * 1000,
        limit,
        keyGenerator: req => (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`),
        standardHeaders: true,
        legacyHeaders: false,
        validate: false,
        handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down.' }),
    };
}

module.exports = { readRateLimitOptions };
