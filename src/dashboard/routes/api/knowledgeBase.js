const express = require('express');
const router = express.Router();
const KnowledgeBase = require('../../../models/KnowledgeBase');
const Guild = require('../../../models/Guild');
const { embedForStorage } = require('../../../services/ai/embeddings');
const { embeddingTextOfEntry } = require('../../../services/ai/knowledge');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { readPage, pageEnvelope } = require('../../lib/apiPage');

// The entry's semantic vector, when the guild has the tier on (#1042), or null.
//
// Best-effort on the write path: the tier being off, an embedder that cannot be
// stood up, or an embedding call that fails all resolve to "store no vector,
// fall back to keyword retrieval" — never to a failed save. The guild's `ai`
// settings decide provider and model; they are read lean, and the embedder
// decrypts the provider key itself.
async function embedEntry(guildId, entry) {
    try {
        const guild = await Guild.findOne({ guildId }, { ai: 1 }).lean();
        return await embedForStorage(guild?.ai || {}, embeddingTextOfEntry(entry));
    } catch (error) {
        console.warn(`[KB] could not embed entry for guild ${guildId}: ${error.message}`);
        return null;
    }
}

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
        const fields = {
            guildId,
            title: title.trim().slice(0, 200),
            content: content.trim().slice(0, 4000),
            tags: sanitizedTags,
            addedBy: req.user.id
        };
        const vector = await embedEntry(guildId, fields);
        if (vector) {
            fields.embedding = vector.embedding;
            fields.embeddingModel = vector.embeddingModel;
        }
        const entry = await KnowledgeBase.create(fields);
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
        const fields = {
            title: title.trim().slice(0, 200),
            content: content.trim().slice(0, 4000),
            tags: sanitizedTags
        };
        // The content changed, so any existing vector is now stale. Re-embed if
        // the tier is on; otherwise clear the old vector rather than leave one
        // that describes the previous text — a stale vector would rank this
        // entry against the wrong meaning until it was next edited.
        const vector = await embedEntry(guildId, fields);
        const update = vector
            ? { $set: { ...fields, embedding: vector.embedding, embeddingModel: vector.embeddingModel } }
            : { $set: fields, $unset: { embedding: '', embeddingModel: '' } };

        const entry = await KnowledgeBase.findOneAndUpdate(
            { _id: entryId, guildId },
            update,
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
