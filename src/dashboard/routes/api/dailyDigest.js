const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

const SNOWFLAKE_RE = /^\d{17,19}$/;
function isSnowflake(id) { return typeof id === 'string' && SNOWFLAKE_RE.test(id); }

// The guild's AI daily digest settings.
router.get('/guild/:guildId/daily-digest', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
        const settings = await Guild.findOne({ guildId });
        if (!settings) return res.status(404).json({ error: 'Guild not found' });
        res.json(settings.ai?.dailyDigest || {});
    } catch (error) {
        console.error('Daily digest get error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Updates the daily digest: on/off, target and source channels, and the local time it is posted.
router.put('/guild/:guildId/daily-digest', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { enabled, channelId, sourceChannelIds, hour, minute, timezone } = req.body;

    if (hour !== undefined && !/^\d+$/.test(String(hour))) return res.status(400).json({ error: 'hour must be a non-negative integer' });
    if (minute !== undefined && !/^\d+$/.test(String(minute))) return res.status(400).json({ error: 'minute must be a non-negative integer' });
    const h = hour !== undefined ? parseInt(hour, 10) : undefined;
    const m = minute !== undefined ? parseInt(minute, 10) : undefined;
    if (h !== undefined && (h < 0 || h > 23)) return res.status(400).json({ error: 'hour must be 0–23' });
    if (m !== undefined && (m < 0 || m > 59)) return res.status(400).json({ error: 'minute must be 0–59' });

    try {
        const settings = await Guild.findOne({ guildId });
        if (!settings) return res.status(404).json({ error: 'Guild not found' });

        if (!settings.ai) settings.ai = {};
        if (!settings.ai.dailyDigest) settings.ai.dailyDigest = {};

        if (typeof enabled === 'boolean') settings.ai.dailyDigest.enabled = enabled;
        if (channelId !== undefined) settings.ai.dailyDigest.channelId = isSnowflake(channelId) ? channelId : null;
        if (Array.isArray(sourceChannelIds)) {
            settings.ai.dailyDigest.sourceChannelIds = [...new Set(sourceChannelIds.filter(isSnowflake))];
        }
        if (h !== undefined) settings.ai.dailyDigest.hour = h;
        if (m !== undefined) settings.ai.dailyDigest.minute = m;
        if (typeof timezone === 'string' && timezone.trim()) {
            try {
                Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() });
                settings.ai.dailyDigest.timezone = timezone.trim();
            } catch {
                return res.status(400).json({ error: 'Invalid timezone' });
            }
        }

        settings.markModified('ai');
        await settings.save();
        res.json({ success: true, dailyDigest: settings.ai.dailyDigest });
    } catch (error) {
        console.error('Daily digest update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
