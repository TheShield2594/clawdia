const express = require('express');
const router = express.Router();
const KnowledgeBase = require('../../../models/KnowledgeBase');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { readPage, pageEnvelope } = require('../../lib/apiPage');

// One page of the guild's knowledge base entries, newest first.
//
// The hard `.limit(100)` this replaces (#583) had no cursor beside it, so a
// guild's hundred-and-first entry was not merely off the first page — it was
// unreachable through the API, and unremovable through the dashboard that lists
// it. Paged the same way cases and the leveling leaderboard are.
router.get('/guild/:guildId/knowledge-base', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { page, limit, skip } = readPage(req, { defaultLimit: 25, maxLimit: 100 });
    try {
        const [items, total] = await Promise.all([
            KnowledgeBase.find({ guildId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
            KnowledgeBase.countDocuments({ guildId }),
        ]);
        res.json(pageEnvelope({ items, total, page, limit }));
    } catch (error) {
        console.error('Knowledge base list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Adds a knowledge base entry the AI can draw on, with up to 10 tags.
router.post('/guild/:guildId/knowledge-base', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { title, content, tags } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Content is required' });
    }

    const sanitizedTags = Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10) : [];

    try {
        const entry = await KnowledgeBase.create({
            guildId,
            title: title.trim().slice(0, 200),
            content: content.trim().slice(0, 4000),
            tags: sanitizedTags,
            addedBy: req.user.id
        });
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Knowledge base add error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Deletes one knowledge base entry.
router.delete('/guild/:guildId/knowledge-base/:entryId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, entryId } = req.params;

    if (!/^[0-9a-f]{24}$/i.test(entryId)) {
        return res.status(400).json({ error: 'Invalid entry ID' });
    }

    try {
        const result = await KnowledgeBase.deleteOne({ _id: entryId, guildId });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Knowledge base delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Replaces one knowledge base entry's title, content and tags.
router.put('/guild/:guildId/knowledge-base/:entryId', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, entryId } = req.params;
    const { title, content, tags } = req.body;

    if (!/^[0-9a-f]{24}$/i.test(entryId)) {
        return res.status(400).json({ error: 'Invalid entry ID' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Content is required' });
    }

    const sanitizedTags = Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10) : [];

    try {
        const entry = await KnowledgeBase.findOneAndUpdate(
            { _id: entryId, guildId },
            {
                title: title.trim().slice(0, 200),
                content: content.trim().slice(0, 4000),
                tags: sanitizedTags
            },
            { new: true }
        );
        if (!entry) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        res.json({ success: true, entry });
    } catch (error) {
        console.error('Knowledge base update error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
