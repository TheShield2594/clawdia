const express = require('express');
const router = express.Router();
const Case = require('../../../models/Case');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId, logAuditEvent } = require('../../lib/apiHelpers');
const { readPage, pageEnvelope } = require('../../lib/apiPage');

// One page of moderation cases, filterable by `?type=` and `?status=`.
router.get('/guild/:guildId/cases', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { page, limit, skip } = readPage(req, { defaultLimit: 20, maxLimit: 50 });
    const type = req.query.type || null;
    const status = req.query.status || null;

    try {
        const query = { guildId };
        if (type && ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'note', 'appeal'].includes(type)) query.type = type;
        if (status && ['open', 'closed', 'appealed', 'appeal_approved', 'appeal_denied'].includes(status)) query.status = status;

        const [cases, total] = await Promise.all([
            Case.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Case.countDocuments(query)
        ]);

        const uniqueIds = [...new Set(cases.flatMap(c => [c.targetUserId, c.moderatorId].filter(Boolean)))];
        const userMap = await req.bot.resolveUsers(uniqueIds);

        res.json(pageEnvelope({
            items: cases.map(c => ({
                ...c,
                targetUserTag: userMap[c.targetUserId]?.tag || null,
                targetAvatarUrl: userMap[c.targetUserId]?.avatarUrl || null,
                moderatorTag: userMap[c.moderatorId]?.tag || null,
            })),
            total, page, limit
        }));
    } catch (error) {
        console.error('Cases list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Adds a moderator note to a case, or closes it with a resolution.
router.patch('/guild/:guildId/cases/:caseId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, caseId } = req.params;
    const { action, note, resolution } = req.body;

    if (!action || !['add_note', 'close'].includes(action)) {
        return res.status(400).json({ error: 'action must be "add_note" or "close"' });
    }

    const parsedId = parseInt(caseId, 10);
    if (!Number.isFinite(parsedId)) return res.status(400).json({ error: 'Invalid caseId' });

    try {
        const c = await Case.findOne({ guildId, caseId: parsedId });
        if (!c) return res.status(404).json({ error: 'Case not found' });

        if (action === 'add_note') {
            if (!note || typeof note !== 'string' || !note.trim()) {
                return res.status(400).json({ error: 'note is required for add_note' });
            }
            c.notes.push({ moderatorId: req.user.id, content: note.trim().slice(0, 1000) });
        } else if (action === 'close') {
            c.status = 'closed';
            c.resolvedAt = new Date();
            c.resolvedBy = req.user.id;
            if (resolution && typeof resolution === 'string') {
                c.resolution = resolution.trim().slice(0, 500);
            }
        }

        await c.save();
        await logAuditEvent(req, guildId, 'case_update', { caseId: parsedId, action });
        res.json({ success: true, case: c });
    } catch (error) {
        console.error('Case update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Up to 200 active bans and 200 active timeouts, read live from Discord.
// Each gateway call is capped at 200, so a guild past either cap is truncated.
router.get('/guild/:guildId/sanctions/active', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
        if (!req.bot.hasGuild(guildId)) return res.status(404).json({ error: 'Guild not found or bot not in guild' });

        let bans;
        try {
            bans = await req.bot.listBans(guildId, 200);
        } catch (banErr) {
            // The guild is there — this is Discord refusing the fetch, which is
            // almost always a missing Ban Members permission.
            console.error('Active sanctions: bans fetch failed:', banErr);
            return res.status(503).json({ error: 'Could not fetch bans from Discord. Check bot permissions.' });
        }

        const banList = bans.map(b => ({ type: 'ban', ...b, expires: null }));
        const timeoutList = (req.bot.listActiveTimeouts(guildId, 200) || [])
            .map(t => ({ type: 'timeout', ...t, reason: null }));

        res.json({ bans: banList, timeouts: timeoutList });
    } catch (error) {
        console.error('Active sanctions error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Lifts a ban, attributing it to the dashboard user, and writes an audit entry.
router.post('/guild/:guildId/sanctions/unban/:userId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isValidDiscordId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    try {
        const unbanned = await req.bot.unban(guildId, userId, `Unbanned via dashboard by ${req.user.username}`);
        if (unbanned === null) return res.status(404).json({ error: 'Guild not found' });
        await logAuditEvent(req, guildId, 'unban', { targetUserId: userId });
        res.json({ success: true });
    } catch (error) {
        console.error('Unban error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Clears a member's timeout, attributing it to the dashboard user, and writes an audit entry.
router.post('/guild/:guildId/sanctions/untimeout/:userId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isValidDiscordId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    try {
        const cleared = await req.bot.clearTimeout(guildId, userId, `Timeout removed via dashboard by ${req.user.username}`);
        if (cleared === null) return res.status(404).json({ error: 'Guild not found' });
        if (cleared === 'no-member') return res.status(404).json({ error: 'Member not found' });
        await logAuditEvent(req, guildId, 'untimeout', { targetUserId: userId });
        res.json({ success: true });
    } catch (error) {
        console.error('Remove timeout error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

module.exports = router;
