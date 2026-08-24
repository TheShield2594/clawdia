const express = require('express');
const router = express.Router();
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

// Up to 10 members matching `?q=` (2 characters or more), for the dashboard's member pickers.
//
// `{ items }` rather than the bare array this used to answer with (#582). A
// typeahead is the one list here that genuinely does not page — it is capped at
// ten by relevance, not by offset — but a bare array is still the shape that
// cannot grow a field later without breaking every caller at once, so it wears
// the same envelope as the lists that do page.
router.get('/guild/:guildId/members/search', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });
    try {
        const results = await req.bot.searchMembers(guildId, q, 10);
        if (!results) return res.status(404).json({ error: 'Guild not found' });
        res.json({ items: results.map(m => ({
            id: m.id,
            username: m.username,
            displayName: m.displayName,
            avatarURL: m.avatarUrl
        })) });
    } catch (err) {
        console.error('Member search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Resolves up to 50 comma-separated user ids in `?ids=` to names and avatars.
router.get('/guild/:guildId/members/resolve', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s)).slice(0, 50);
    if (!ids.length) return res.json({});
    try {
        const users = await req.bot.resolveUsers(ids);
        const result = {};
        for (const id of ids) {
            const user = users[id];
            result[id] = user
                ? { id, username: user.username, displayName: user.displayName, avatarURL: user.avatarUrl }
                : null;
        }
        res.json(result);
    } catch (err) {
        console.error('Member resolve error:', err);
        res.status(500).json({ error: 'Resolve failed' });
    }
});

module.exports = router;
