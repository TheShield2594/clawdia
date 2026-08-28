const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

// Creates or replaces the AI persona — name and system prompt — for one channel.
router.post('/guild/:guildId/persona', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { channelId, personaName, systemPrompt } = req.body;

    if (!channelId || typeof channelId !== 'string' || !channelId.trim()) {
        return res.status(400).json({ error: 'channelId is required' });
    }
    if (!personaName || typeof personaName !== 'string' || !personaName.trim()) {
        return res.status(400).json({ error: 'personaName is required' });
    }
    if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
        return res.status(400).json({ error: 'systemPrompt is required' });
    }

    try {
        if (!req.bot.hasGuild(guildId)) return res.status(404).json({ error: 'Guild not found' });
        if (!req.bot.hasChannel(guildId, channelId.trim())) {
            return res.status(400).json({ error: 'Channel not found in this guild' });
        }

        const cid = channelId.trim();
        const pName = personaName.trim().slice(0, 100);
        const pPrompt = systemPrompt.trim().slice(0, 4000);

        // Try to update an existing persona for this channel atomically.
        let result = await Guild.findOneAndUpdate(
            { guildId, 'ai.channelPersonas.channelId': cid },
            { $set: { 'ai.channelPersonas.$.personaName': pName, 'ai.channelPersonas.$.systemPrompt': pPrompt } },
            { new: true }
        );

        // No matching persona — push a new one.
        if (!result) {
            result = await Guild.findOneAndUpdate(
                { guildId },
                { $push: { 'ai.channelPersonas': { channelId: cid, personaName: pName, systemPrompt: pPrompt } } },
                { new: true }
            );
        }

        if (!result) return res.status(404).json({ error: 'Guild settings not found' });
        res.json({ success: true, personas: result.ai?.channelPersonas || [] });
    } catch (error) {
        console.error('Persona set error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Removes a channel's persona, returning it to the guild's default system prompt.
router.delete('/guild/:guildId/persona/:channelId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, channelId } = req.params;

    try {
        const result = await Guild.findOneAndUpdate(
            { guildId, 'ai.channelPersonas.channelId': channelId },
            { $pull: { 'ai.channelPersonas': { channelId } } }
        );
        if (!result) return res.status(404).json({ error: 'Persona not found for that channel' });
        res.json({ success: true });
    } catch (error) {
        console.error('Persona remove error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Token and request usage for the last `?days=` (1-90, default 14), plus the
// configured rate limits and what is left of the monthly ceiling (#831).
router.get('/guild/:guildId/ai/usage', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));

    try {
        const { getUsageStats, loadMonthlyUsage } = require('../../../services/aiService');
        const guildSettings = await Guild.findOne({ guildId }).lean();
        const stats = await getUsageStats(guildId, days);

        const ai = guildSettings?.ai || {};
        const monthlyTokens = ai.monthlyTokenLimit ?? 0;
        const monthlyCost = ai.monthlyCostLimit ?? 0;

        // Read from the ledger rather than from the enforcement cache: a panel
        // somebody opened to find out where they stand should not answer "not
        // loaded yet" on a process that has not served this guild recently.
        // What it reports is what the next cache refresh will enforce on.
        let budget = null;
        if (monthlyTokens > 0 || monthlyCost > 0) {
            const used = await loadMonthlyUsage(guildId);
            budget = {
                month: used.month,
                tokens: monthlyTokens > 0
                    ? { used: used.tokens, limit: monthlyTokens, remaining: Math.max(0, monthlyTokens - used.tokens) }
                    : null,
                cost: monthlyCost > 0
                    ? {
                        used: Math.round(used.cost * 10000) / 10000,
                        limit: monthlyCost,
                        remaining: Math.round(Math.max(0, monthlyCost - used.cost) * 10000) / 10000,
                        complete: used.costKnown
                    }
                    : null
            };
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
