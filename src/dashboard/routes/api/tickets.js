const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess } = require('../../lib/middleware');

// List the tickets currently open on this guild, newest first, with the opener and claimer tags resolved.
router.get('/guild/:guildId/tickets', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const doc = await Guild.findOne({ guildId }, { 'tickets.open': 1 });
        const open = doc?.tickets?.open || [];

        // One facade call resolves every opener and claimer to a tag; unresolved
        // ids (a user who left) come back null and render as the raw id.
        const ids = [...new Set(open.flatMap(t => [t.openerId, t.claimedBy]).filter(Boolean))];
        const users = ids.length ? await req.bot.resolveUsers(ids) : {};

        const items = open
            .slice()
            .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt))
            .map(t => ({
                ticketId: t.ticketId,
                threadId: t.threadId,
                openerId: t.openerId,
                openerTag: users[t.openerId]?.tag || null,
                subject: t.subject || '',
                claimedBy: t.claimedBy || null,
                claimedByTag: t.claimedBy ? (users[t.claimedBy]?.tag || null) : null,
                openedAt: t.openedAt,
            }));

        res.json({ items });
    } catch (error) {
        console.error('Tickets list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
