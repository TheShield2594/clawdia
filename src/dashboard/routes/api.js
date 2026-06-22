const express = require('express');
const router = express.Router();

router.use(require('./api/settings'));
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
