const express = require('express');
const router = express.Router();
const { computeRetention } = require('../lib/apiHelpers');
const { checkCsrfOrigin, checkReadRateLimit } = require('../lib/middleware');

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
router.use(require('./api/members'));
router.use(require('./api/achievements'));
router.use(require('./api/itemImages'));
router.use(require('./api/moderation'));
router.use(require('./api/economy'));
router.use(require('./api/leveling'));

module.exports = router;
module.exports.computeRetention = computeRetention;
module.exports.validateEventLogUpdate = settingsRouter.validateEventLogUpdate;
