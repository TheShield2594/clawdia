const express = require('express');
const router = express.Router();
const { computeRetention } = require('../lib/apiHelpers');
const { checkCsrfOrigin } = require('../lib/middleware');

// Origin validation for every state-changing API request, applied once here
// rather than per-route. It was previously listed on a handful of routes and
// silently missing from the rest (autorole, knowledge base, reaction roles,
// RSS, summary jobs, leveling, achievements, personas, item images), which is
// exactly the kind of gap a per-route opt-in produces. Mounting it centrally
// means a newly added route is covered by default.
router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
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
router.use(require('./api/members'));
router.use(require('./api/achievements'));
router.use(require('./api/itemImages'));
router.use(require('./api/moderation'));
router.use(require('./api/economy'));
router.use(require('./api/leveling'));

module.exports = router;
module.exports.computeRetention = computeRetention;
module.exports.validateEventLogUpdate = settingsRouter.validateEventLogUpdate;
