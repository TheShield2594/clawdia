const express = require('express');
const router = express.Router();
const Case = require('../../../models/Case');
const { checkAuth, checkGuildAccess, checkCsrfOrigin, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId, logAuditEvent } = require('../../lib/apiHelpers');

router.get('/guild/:guildId/cases', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const type = req.query.type || null;
    const status = req.query.status || null;

    try {
        const query = { guildId };
        if (type && ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'note', 'appeal'].includes(type)) query.type = type;
        if (status && ['open', 'closed', 'appealed', 'appeal_approved', 'appeal_denied'].includes(status)) query.status = status;

        const [cases, total] = await Promise.all([
            Case.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
            Case.countDocuments(query)
        ]);

        const uniqueIds = [...new Set(cases.flatMap(c => [c.targetUserId, c.moderatorId].filter(Boolean)))];
        const userMap = {};
        await Promise.all(uniqueIds.map(async id => {
            try {
                const u = await req.client.users.fetch(id, { force: false });
                userMap[id] = { tag: u.tag, avatarUrl: u.displayAvatarURL({ size: 32, extension: 'webp' }) };
            } catch { /* user not resolvable */ }
        }));

        res.json({
            cases: cases.map(c => ({
                ...c,
                targetUserTag: userMap[c.targetUserId]?.tag || null,
                targetAvatarUrl: userMap[c.targetUserId]?.avatarUrl || null,
                moderatorTag: userMap[c.moderatorId]?.tag || null,
            })),
            total, page, pages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Cases list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.patch('/guild/:guildId/cases/:caseId', checkAuth, checkGuildAccess, checkCsrfOrigin, checkWriteRateLimit, async (req, res) => {
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

router.get('/guild/:guildId/sanctions/active', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
        const guild = req.client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found or bot not in guild' });

        let bans;
        try {
            bans = await guild.bans.fetch({ limit: 200 });
        } catch (banErr) {
            console.error('Active sanctions: bans fetch failed:', banErr);
            return res.status(503).json({ error: 'Could not fetch bans from Discord. Check bot permissions.' });
        }

        const now = new Date();
        const timeoutMembers = [...guild.members.cache.values()]
            .filter(m => m.communicationDisabledUntil && m.communicationDisabledUntil > now)
            .slice(0, 200);

        const banList = [...bans.values()].map(b => ({
            type: 'ban',
            userId: b.user.id,
            userTag: b.user.tag,
            avatarUrl: b.user.displayAvatarURL({ size: 32 }),
            reason: b.reason || null,
            expires: null
        }));

        const timeoutList = timeoutMembers.map(m => ({
            type: 'timeout',
            userId: m.user.id,
            userTag: m.user.tag,
            avatarUrl: m.user.displayAvatarURL({ size: 32 }),
            reason: null,
            expires: m.communicationDisabledUntil?.toISOString() || null
        }));

        res.json({ bans: banList, timeouts: timeoutList });
    } catch (error) {
        console.error('Active sanctions error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/guild/:guildId/sanctions/unban/:userId', checkAuth, checkGuildAccess, checkCsrfOrigin, checkWriteRateLimit, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isValidDiscordId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    try {
        const guild = req.client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        await guild.members.unban(userId, `Unbanned via dashboard by ${req.user.username}`);
        await logAuditEvent(req, guildId, 'unban', { targetUserId: userId });
        res.json({ success: true });
    } catch (error) {
        console.error('Unban error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

router.post('/guild/:guildId/sanctions/untimeout/:userId', checkAuth, checkGuildAccess, checkCsrfOrigin, checkWriteRateLimit, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isValidDiscordId(userId)) return res.status(400).json({ error: 'Invalid userId' });
    try {
        const guild = req.client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        await member.timeout(null, `Timeout removed via dashboard by ${req.user.username}`);
        await logAuditEvent(req, guildId, 'untimeout', { targetUserId: userId });
        res.json({ success: true });
    } catch (error) {
        console.error('Remove timeout error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

module.exports = router;
