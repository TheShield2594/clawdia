const express = require('express');
const router = express.Router();
const { computeRetention } = require('../lib/apiHelpers');
const { checkCsrfOrigin, checkReadRateLimit } = require('../lib/middleware');

// Every response below is one guild's private data read through a session
// cookie — member lists, moderation cases, economy balances — and none of it
// said so. The HTML pages that display it have sent `private, no-store` since
// they were written (routes/dashboard.js), but the JSON they fetch it from sent
// no Cache-Control at all, which leaves it to whatever a browser or an
// intermediary decides a cookie-authenticated 200 may be kept for: the disk
// cache, the bfcache, a proxy that was configured without much thought. On a
// shared machine that outlives the session it was fetched in (#904).
//
// Mounted here for the same reason the two checks below are: a per-route opt-in
// is a list someone has to remember to add to, and this one had been missed by
// every route in the router. First, so that the responses those checks
// short-circuit with carry it too. A route that genuinely wants its response
// cached sets its own header in the handler and overwrites this one — which is
// what the two item-image reads in routes/api/itemImages.js do.
router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});

// Origin validation for every state-changing API request, and a rate limit on
// every read, applied once here rather than per-route. Origin validation was
// previously listed on a handful of routes and silently missing from the rest
// (autorole, knowledge base, reaction roles, RSS, summary jobs, leveling,
// achievements, personas, item images), which is exactly the kind of gap a
// per-route opt-in produces; the read limit had no per-route opt-in to be
// missing from at all. Mounting both centrally means a newly added route is
// covered by default.
router.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.method === 'GET' || req.method === 'HEAD') return checkReadRateLimit(req, res, next);
    return checkCsrfOrigin(req, res, next);
});

const settingsRouter = require('./api/settings');
router.use(settingsRouter);
router.use(require('./api/stats'));
router.use(require('./api/autorole'));
router.use(require('./api/reactionRoles'));
router.use(require('./api/rss'));
router.use(require('./api/knowledgeBase'));
router.use(require('./api/summaryJobs'));
router.use(require('./api/dailyDigest'));
router.use(require('./api/ai'));
router.use(require('./api/mcpServers'));
router.use(require('./api/mcpOAuth'));
router.use(require('./api/members'));
router.use(require('./api/achievements'));
router.use(require('./api/itemImages'));
router.use(require('./api/moderation'));
router.use(require('./api/economy'));
router.use(require('./api/leveling'));

module.exports = router;
module.exports.computeRetention = computeRetention;
module.exports.validateEventLogUpdate = settingsRouter.validateEventLogUpdate;
