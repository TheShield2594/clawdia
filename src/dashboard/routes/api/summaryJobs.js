const express = require('express');
const router = express.Router();
const SummaryJob = require('../../../models/SummaryJob');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

const MAX_SUMMARY_JOBS_PER_GUILD = 10;

router.get('/guild/:guildId/summary-jobs', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
        const jobs = await SummaryJob.find({ guildId }).sort({ createdAt: 1 });
        res.json(jobs);
    } catch (error) {
        console.error('Summary jobs list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/guild/:guildId/summary-jobs', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { sourceChannelId, targetChannelId, hour, minute, label } = req.body;

    if (!sourceChannelId || typeof sourceChannelId !== 'string' || !sourceChannelId.trim()) {
        return res.status(400).json({ error: 'sourceChannelId is required' });
    }
    if (!targetChannelId || typeof targetChannelId !== 'string' || !targetChannelId.trim()) {
        return res.status(400).json({ error: 'targetChannelId is required' });
    }
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) return res.status(400).json({ error: 'hour must be 0–23' });
    if (!Number.isFinite(m) || m < 0 || m > 59) return res.status(400).json({ error: 'minute must be 0–59' });

    try {
        const guild = req.client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });

        const srcChannel = guild.channels.cache.get(sourceChannelId.trim());
        const tgtChannel = guild.channels.cache.get(targetChannelId.trim());
        if (!srcChannel || !tgtChannel) return res.status(400).json({ error: 'One or both channels not found in this guild' });

        const jobCount = await SummaryJob.countDocuments({ guildId });
        if (jobCount >= MAX_SUMMARY_JOBS_PER_GUILD) {
            return res.status(400).json({ error: `Maximum of ${MAX_SUMMARY_JOBS_PER_GUILD} summary jobs per server reached.` });
        }

        const jobLabel = (typeof label === 'string' && label.trim())
            ? label.trim().slice(0, 100)
            : `Daily Summary of #${srcChannel.name}`.slice(0, 100);

        const job = await SummaryJob.create({
            guildId,
            sourceChannelId: sourceChannelId.trim(),
            targetChannelId: targetChannelId.trim(),
            hour: h,
            minute: m,
            label: jobLabel
        });
        res.json({ success: true, job });
    } catch (error) {
        console.error('Summary job create error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/guild/:guildId/summary-jobs/:jobId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, jobId } = req.params;

    if (!/^[0-9a-f]{24}$/i.test(jobId)) {
        return res.status(400).json({ error: 'Invalid job ID' });
    }

    try {
        const result = await SummaryJob.deleteOne({ _id: jobId, guildId });
        if (result.deletedCount === 0) return res.status(404).json({ error: 'Job not found' });
        res.json({ success: true });
    } catch (error) {
        console.error('Summary job delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
