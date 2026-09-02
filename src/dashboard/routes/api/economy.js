const express = require('express');
const router = express.Router();
const GuildAnalytics = require('../../../models/GuildAnalytics');
const User = require('../../../models/User');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId, logAuditEvent, readAdjustAmount, MAX_ADJUST_TOTAL } = require('../../lib/apiHelpers');
const { topByNetWorth } = require('../../../utils/netWorth');
const { cachedAggregate, invalidatePrefix } = require('../../lib/aggregateCache');

// Command telemetry lives in its own GuildAnalytics collection; this route
// reads command names out of it and nothing from the Guild document at all.
const ECONOMY_ANALYTICS_FIELDS = 'commandUsage';

// Economy overview: richest members by net worth, coins in circulation, the
// count of members who worked, claimed a daily or fished in the last 7 days,
// and the top commands.
router.get('/guild/:guildId/economy/stats', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    try {
        // The net-worth ranking sorts on a field the aggregation computes, so no index
        // can serve the ordering — it is a scan of the guild's users every time, as
        // are the two `$group`s beside it. Memoised on a short TTL so a dashboard
        // that opens two panels, or a tab left refreshing, does not re-run all three
        // against data that has not moved. See lib/aggregateCache.
        const [topEarners, totalCoinsAgg, activeUsersCount, analytics] = await Promise.all([
            cachedAggregate(`${guildId}:economy:top`, () => topByNetWorth(User, guildId, 10)),
            cachedAggregate(`${guildId}:economy:total`, () => User.aggregate([
                { $match: { guildId } },
                { $group: { _id: null, total: { $sum: { $add: ['$balance', '$bank'] } } } }
            ])),
            cachedAggregate(`${guildId}:economy:active`, () => User.countDocuments({ guildId, $or: [
                { lastWork:  { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastDaily: { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastFish:  { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastMine:  { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastCrime: { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastHeist: { $gte: new Date(Date.now() - 7 * 864e5) } },
                { lastRob:   { $gte: new Date(Date.now() - 7 * 864e5) } }
            ] })),
            GuildAnalytics.findOne({ guildId }).select(ECONOMY_ANALYTICS_FIELDS).lean()
        ]);

        const commandUsage = analytics?.commandUsage || [];
        const econCommands = ['balance', 'daily', 'work', 'shop', 'rob', 'crime', 'duel', 'mine', 'fish', 'hunt', 'bank', 'pay', 'coinflip', 'roll', 'blackjack', 'casino'];
        const commandFrequency = {};
        for (const ev of commandUsage) {
            if (econCommands.includes(ev.command)) {
                commandFrequency[ev.command] = (commandFrequency[ev.command] || 0) + 1;
            }
        }

        const ecoUserMap = await req.bot.resolveUsers(topEarners.map(u => u.userId));

        res.json({
            totalCoins: totalCoinsAgg[0]?.total || 0,
            activeUsers: activeUsersCount,
            topEarners: topEarners.map(u => ({
                userId: u.userId,
                userTag: ecoUserMap[u.userId]?.tag || null,
                avatarUrl: ecoUserMap[u.userId]?.avatarUrl || null,
                balance: u.balance, bank: u.bank,
                total: u.netWorth
            })),
            commandFrequency: Object.entries(commandFrequency).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([cmd, count]) => ({ cmd, count }))
        });
    } catch (error) {
        console.error('Economy stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Gives, takes, resets, freezes or unfreezes one member's balance, and writes an audit entry.
router.post('/guild/:guildId/economy/adjust', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { userId, action, amount } = req.body;

    if (!userId || !isValidDiscordId(String(userId))) return res.status(400).json({ error: 'userId must be a valid Discord snowflake' });
    if (!action || !['give', 'take', 'reset', 'freeze', 'unfreeze'].includes(action)) {
        return res.status(400).json({ error: 'action must be give, take, reset, freeze, or unfreeze' });
    }
    let amt = null;
    if (['give', 'take'].includes(action)) {
        const read = readAdjustAmount(amount);
        if (read.error) return res.status(400).json({ error: `${read.error} for give/take` });
        amt = read.value;
    }

    try {
        const filter = { userId: String(userId), guildId };
        let update;
        // A pipeline update has to say so under Mongoose 9, or the call throws
        // rather than running (see tests/updatePipelineOption.test.js).
        const options = { new: true };
        if (action === 'give') {
            // Clamped at MAX_ADJUST_TOTAL inside the update, not by reading the
            // balance first: the ceiling exists to keep the balance exactly
            // representable, and a read-then-$inc lets two admins adjusting at
            // once step over it between the read and the write. `$ifNull` guards
            // documents written before `balance` had a default — the take below
            // needs no such guard, since `$max` against 0 already answers 0 for
            // a missing field.
            update = [{ $set: { balance: { $min: [MAX_ADJUST_TOTAL, { $add: [{ $ifNull: ['$balance', 0] }, amt] }] } } }];
            options.updatePipeline = true;
        } else if (action === 'take') {
            // Use aggregation pipeline update to clamp balance at 0 atomically.
            update = [{ $set: { balance: { $max: [0, { $subtract: ['$balance', amt] }] } } }];
            options.updatePipeline = true;
        } else if (action === 'reset') {
            update = { $set: { balance: 0, bank: 0 } };
        } else if (action === 'freeze') {
            // What this flag actually does now lives in src/utils/economyFreeze.js.
            // Until #870 it did nothing at all: it was written here, echoed back
            // below, recorded in the audit log — and read by no command, event
            // handler or wager path, so the member kept earning, gambling,
            // gifting and transferring while a moderator believed a sanction was
            // in force. It is enforced in the filter of every shared debit and at
            // the economy command gate; unfreezing is the same write inverted, so
            // nothing has to be undone here.
            update = { $set: { economyFrozen: true } };
        } else {
            update = { $set: { economyFrozen: false } };
        }

        // No upsert (#584). A snowflake is 17-19 digits with no checksum, so a
        // mistyped one is still a well-formed id: upserting created a member
        // document for a user who is not in the guild — and possibly does not
        // exist — while reporting success, and the admin's coins went nowhere
        // anyone could see. A member with no row has never run a command here,
        // which is a 404, not a row to create.
        const user = await User.findOneAndUpdate(filter, update, options);
        if (!user) return res.status(404).json({ error: 'That member has no economy record in this server' });
        // An admin who has just moved someone's coins expects to see it, and a
        // thirty-second-old total would read as the adjustment not having applied.
        invalidatePrefix(`${guildId}:`);
        await logAuditEvent(req, guildId, 'economy_adjust', { targetUserId: String(userId), action, amount: amt });
        res.json({ success: true, balance: user.balance, bank: user.bank, economyFrozen: user.economyFrozen });
    } catch (error) {
        console.error('Economy adjust error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
