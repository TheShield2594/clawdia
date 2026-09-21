const express = require('express');
const router = express.Router();
const { rateLimit } = require('express-rate-limit');
const { checkAuth } = require('../../lib/middleware');
const { readRateLimitOptions } = require('../../lib/readRateLimit');

// A dedicated "is my session still alive?" probe.
//
// The dashboard's session-expired banner used to be raised by any single request
// that came back 401 or as an opaque redirect. On the overview those are the two
// stats reads fired in parallel on load, and a transient 401 against an
// otherwise-valid session — one that a fresh request would not reproduce — was
// enough to raise a page-dominating alarm that then had nothing to take it back
// down, because the overview makes no further requests once it has loaded. The
// banner "kept appearing" while every control on the page still worked.
//
// The page now confirms a suspected expiry against this route before showing the
// banner, and re-checks it to take the banner down again. It answers only about
// the session: 200 when the cookie still authenticates, a clean 401 when it does
// not, and — unlike a page route, which 302s to /auth/login and on to Discord —
// it never redirects, so the answer the probe reads is unambiguous. It touches
// no database and reads no guild, so it is cheap enough to poll.
//
// Rate-limited with the recognised express-rate-limit limiter for the same reason
// /stats is (lib/readRateLimit.js): the router-wide BoundedRateLimiter is
// invisible to CodeQL's js/missing-rate-limiting. The ceiling is generous — a
// probe fires on a suspected expiry and when a backgrounded tab regains focus,
// not in a loop.
router.use(rateLimit(readRateLimitOptions(120)));

// Whether this session still authenticates: 200 when it does, 401 when it does
// not, and never a redirect — the unambiguous signal the banner confirms against.
router.get('/session', checkAuth, (_req, res) => {
    res.json({ authenticated: true });
});

module.exports = router;
