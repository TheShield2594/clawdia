const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const { checkAuth, checkGuildAccess, checkCsrfOrigin, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId, logAuditEvent } = require('../../lib/apiHelpers');

router.get('/guild/:guildId/economy/stats', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
        const [topEarners, totalCoinsAgg, activeUsersCount, guildSettings] = await Promise.all([
            User.aggregate([
                { $match: { guildId } },
                { $addFields: { total: { $add: ['$balance', '$bank'] } } },
                { $sort: { total: -1 } },
                { $limit: 10 },
                { $project: { _id: 0, userId: 1, balance: 1, bank: 1, total: 1 } }
            ]),
            User.aggregate([{ $match: { guildId } }, { $group: { _id: null, total: { $sum: { $add: ['$balance', '$bank'] } } } }]),
            User.countDocuments({ guildId, $or: [
                { lastWork:  { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastDaily: { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastFish:  { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastMine:  { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastCrime: { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastHeist: { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastRob:   { $gte: new Date(Date.now() - 7 * 864e5) } }
            ] }),
            Guild.findOne({ guildId }).lean()
        ]);

        const commandUsage = guildSettings?.analytics?.commandUsage || [];
        const econCommands = ['balance', 'daily', 'work', 'shop', 'rob', 'crime', 'duel', 'mine', 'fish', 'hunt', 'bank', 'pay', 'coinflip', 'roll', 'blackjack', 'casino'];
        const commandFrequency = {};
        for (const ev of commandUsage) {
            if (econCommands.includes(ev.command)) {
                commandFrequency[ev.command] = (commandFrequency[ev.command] || 0) + 1;
            }
        }

        const ecoUserMap = {};
        await Promise.all(topEarners.map(async u => {
            try {
                const user = await req.client.users.fetch(u.userId, { force: false });
                ecoUserMap[u.userId] = { tag: user.tag, avatarUrl: user.displayAvatarURL({ size: 32, extension: 'webp' }) };
            } catch { /* user not resolvable */ }
        }));

        res.json({
            totalCoins: totalCoinsAgg[0]?.total || 0,
            activeUsers: activeUsersCount,
            topEarners: topEarners.map(u => ({
                userId: u.userId,
                userTag: ecoUserMap[u.userId]?.tag || null,
                avatarUrl: ecoUserMap[u.userId]?.avatarUrl || null,
                balance: u.balance, bank: u.bank,
                total: (u.balance || 0) + (u.bank || 0)
            })),
            commandFrequency: Object.entries(commandFrequency).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([cmd, count]) => ({ cmd, count }))
        });
    } catch (error) {
        console.error('Economy stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/guild/:guildId/economy/adjust', checkAuth, checkGuildAccess, checkCsrfOrigin, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { userId, action, amount } = req.body;

    if (!userId || !isValidDiscordId(String(userId))) return res.status(400).json({ error: 'userId must be a valid Discord snowflake' });
    if (!action || !['give', 'take', 'reset', 'freeze', 'unfreeze'].includes(action)) {
        return res.status(400).json({ error: 'action must be give, take, reset, freeze, or unfreeze' });
    }
    if (['give', 'take'].includes(action)) {
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0 || !Number.isInteger(amt)) {
            return res.status(400).json({ error: 'amount must be a positive integer for give/take' });
        }
    }

    try {
        const filter = { userId: String(userId), guildId };
        let update;
        if (action === 'give') {
            update = { $inc: { balance: Number(amount) } };
        } else if (action === 'take') {
            // Use aggregation pipeline update to clamp balance at 0 atomically.
            update = [{ $set: { balance: { $max: [0, { $subtract: ['$balance', Number(amount)] }] } } }];
        } else if (action === 'reset') {
            update = { $set: { balance: 0, bank: 0 } };
        } else if (action === 'freeze') {
            update = { $set: { economyFrozen: true } };
        } else {
            update = { $set: { economyFrozen: false } };
        }

        const user = await User.findOneAndUpdate(filter, update, { upsert: true, new: true, setDefaultsOnInsert: true });
        await logAuditEvent(req, guildId, 'economy_adjust', { targetUserId: String(userId), action, amount: amount ?? null });
        res.json({ success: true, balance: user.balance, bank: user.bank, economyFrozen: user.economyFrozen });
    } catch (error) {
        console.error('Economy adjust error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
