const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess } = require('../../lib/middleware');

// Token and request usage for the last `?days=` (1-90, default 14), plus the
// configured rate limits and what is left of the monthly ceiling (#831).
router.get('/guild/:guildId/ai/usage', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));

    try {
        const { getUsageStats, loadMonthlyUsage, monthlyBudget } = require('../../../services/aiService');
        const guildSettings = await Guild.findOne({ guildId }).lean();
        const stats = await getUsageStats(guildId, days);

        const ai = guildSettings?.ai || {};
        const monthlyTokens = ai.monthlyTokenLimit ?? 0;
        const monthlyCost = ai.monthlyCostLimit ?? 0;

        // Read from the ledger rather than from the enforcement cache: a panel
        // somebody opened to find out where they stand should not answer "not
        // loaded yet" on a process that has not served this guild recently.
        // What it reports is what the next cache refresh will enforce on — the
        // same shaping function, so the two cannot describe the same budget
        // differently.
        let budget = null;
        if (monthlyTokens > 0 || monthlyCost > 0) {
            const used = await loadMonthlyUsage(guildId);
            budget = { month: used.month, ...monthlyBudget(used, { monthlyTokens, monthlyCost }) };
        }

        res.json({
            ...stats,
            budget,
            rateLimit: {
                perUser: ai.rateLimitPerUser ?? 0,
                perChannel: ai.rateLimitPerChannel ?? 0,
                windowMin: ai.rateLimitWindowMin ?? 10,
                monthlyTokens,
                monthlyCost
            }
        });
    } catch (error) {
        console.error('AI usage stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
