const express = require('express');
const router = express.Router();
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId, logAuditEvent } = require('../../lib/apiHelpers');
const { readPage, pageEnvelope } = require('../../lib/apiPage');
const { fetchTransactions, fetchOwedPayouts } = require('../../../utils/ledger');
const { deleteUserData } = require('../../../utils/userDataRegistry');

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

// One page of a member's transaction ledger, newest first, plus every owed
// payout still outstanding for them. Read-only — it moves no coins and writes no
// Transaction; it is the receipt a moderator needs when a member says their
// coins vanished (#1009). Owed payouts are the debits whose credit half failed
// and are sitting in the dead-letter queue for `npm run payouts:replay`, keyed
// so the row can be matched to the transaction it belongs to.
router.get('/guild/:guildId/members/:userId/ledger', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isValidDiscordId(userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const { limit, skip } = readPage(req, { defaultLimit: 20, maxLimit: 50 });

    try {
        // `readPage` gives a skip; the ledger util pages by number, so hand it a
        // page derived from the same skip and limit and the two stay in step.
        const [{ items, total, page: currentPage }, owed] = await Promise.all([
            fetchTransactions({ userId, guildId, page: Math.floor(skip / limit) + 1, pageSize: limit }),
            fetchOwedPayouts({ userId, guildId }),
        ]);

        // The counterparty on gifts, transfers, market sales and duels, resolved
        // to a name the same way the cases list resolves its moderators.
        const counterpartyIds = [...new Set(items.map(t => t.relatedUserId).filter(Boolean))];
        const userMap = counterpartyIds.length ? await req.bot.resolveUsers(counterpartyIds) : {};

        const body = pageEnvelope({
            items: items.map(t => ({
                id:              String(t._id),
                type:            t.type,
                amount:          t.amount,
                balance:         t.balance,
                bank:            t.bank ?? null,
                note:            t.note ?? null,
                relatedUserId:   t.relatedUserId ?? null,
                relatedUserTag:  t.relatedUserId ? (userMap[t.relatedUserId]?.tag || null) : null,
                createdAt:       t.createdAt,
            })),
            total, page: currentPage, limit,
        });
        body.owed = owed;
        res.json(body);
    } catch (error) {
        console.error('Member ledger error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Erase a member's data on request (#1013). The dashboard twin of `/mydata
// delete` and scripts/delete-user-data.js, for the erasure requests that reach
// the operator by email rather than in Discord. All three call the same
// registry code, so what is removed, what is kept, and how removed balances are
// written back to the guild ledger are defined in one place. The audit log
// keeps a record that an operator ran the erasure — the who and when the server
// is entitled to keep even after the member is gone.
router.delete('/guild/:guildId/members/:userId/data', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!isValidDiscordId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    try {
        const report = await deleteUserData(userId, guildId);
        await logAuditEvent(req, guildId, 'member_data_delete', {
            targetUserId: userId,
            coinsRemoved: report.coinsRemoved,
        });
        res.json({
            success: true,
            coinsRemoved: report.coinsRemoved,
            results: report.results.map(r => ({ key: r.key, label: r.label, behavior: r.behavior, changed: r.changed })),
        });
    } catch (error) {
        console.error('Member data delete error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
