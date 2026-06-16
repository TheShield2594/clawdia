const express = require('express');
const router = express.Router();
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

router.get('/guild/:guildId/members/search', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    try {
        const guild = req.client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        const results = await guild.members.search({ query: q, limit: 10 });
        res.json(results.map(m => ({
            id: m.user.id,
            username: m.user.username,
            displayName: m.displayName,
            avatarURL: m.user.displayAvatarURL({ size: 32, extension: 'webp' })
        })));
    } catch (err) {
        console.error('Member search error:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

router.get('/guild/:guildId/members/resolve', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s)).slice(0, 50);
    if (!ids.length) return res.json({});
    try {
        const result = {};
        await Promise.all(ids.map(async id => {
            try {
                const user = await req.client.users.fetch(id, { force: false });
                result[id] = { id, username: user.username, displayName: user.globalName || user.username, avatarURL: user.displayAvatarURL({ size: 32, extension: 'webp' }) };
            } catch { result[id] = null; }
        }));
        res.json(result);
    } catch (err) {
        console.error('Member resolve error:', err);
        res.status(500).json({ error: 'Resolve failed' });
    }
});

module.exports = router;
