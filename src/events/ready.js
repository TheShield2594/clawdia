const cron = require('node-cron');
const { deployCommands } = require('../utils/commandDeployer');
const { checkRssFeeds, scheduleDailyNews } = require('../services/rssService');
const { checkReminders } = require('../services/reminderService');
const { checkGiveaways } = require('../services/giveawayService');
const { checkTempVoice } = require('../services/tempVoiceService');
const { checkBirthdays } = require('../services/birthdayService');
const { checkSeasonalEvents } = require('../services/seasonalEventService');
const { resolveExpiredWars, resolveExpiredSeasons, awardWeeklyLeaderboardBadges, selectPetOfTheWeek, announceHourlyWinners, recalcShopPrices, resolveRankedSeasons, applyBankInterest, returnExpiredMarketListings, postScheduledNewspapers } = require('../services/schedulerService');
const { runJob } = require('../utils/jobRunner');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');

module.exports = {
    name: 'clientReady',
    once: true,
    async execute(client) {
        console.log(`[READY] Logged in as ${client.user.tag}`);
        console.log(`[READY] Serving ${client.guilds.cache.size} guilds`);

        try {
            const count = await deployCommands(client.user.id, process.env.DISCORD_TOKEN);
            console.log(`[READY] Deployed ${count} slash commands`);
        } catch (error) {
            console.error('[READY] Failed to deploy slash commands:', error);
        }

        client.user.setPresence({
            activities: [{ name: '/help | Clawdia', type: 0 }],
            status: 'online'
        });

        cron.schedule('*/5 * * * *', () =>
            runJob('rssService', 'checkRssFeeds', () => checkRssFeeds(client))
        );

        cron.schedule('* * * * *', () =>
            runJob('reminderService', 'checkReminders', () => checkReminders(client))
        );

        scheduleDailyNews(client);

        cron.schedule('* * * * *', () =>
            runJob('giveawayService', 'checkGiveaways', () => checkGiveaways(client))
        );

        cron.schedule('*/2 * * * *', () =>
            runJob('tempVoiceService', 'checkTempVoice', () => checkTempVoice(client))
        );

        cron.schedule('0 * * * *', () =>
            runJob('birthdayService', 'checkBirthdays', () => checkBirthdays(client))
        );

        // Check seasonal event auto-start/auto-end once per hour
        cron.schedule('0 * * * *', () =>
            runJob('seasonalEventService', 'checkSeasonalEvents', () => checkSeasonalEvents(client))
        );

        // Auto-resolve expired server wars and economy seasons every 5 minutes
        cron.schedule('*/5 * * * *', () =>
            runJob('schedulerService', 'resolveExpiredWars', () => resolveExpiredWars(client))
        );
        cron.schedule('*/5 * * * *', () =>
            runJob('schedulerService', 'resolveExpiredSeasons', () => resolveExpiredSeasons(client))
        );

        // Award weekly leaderboard badges every Sunday at 23:59 UTC
        cron.schedule('59 23 * * 0', () =>
            runJob('schedulerService', 'awardWeeklyLeaderboardBadges', () => awardWeeklyLeaderboardBadges(client)),
            { timezone: 'Etc/UTC' }
        );

        // Select Pet of the Week every Monday at midnight UTC
        cron.schedule('0 0 * * 1', () =>
            runJob('schedulerService', 'selectPetOfTheWeek', () => selectPetOfTheWeek(client)),
            { timezone: 'Etc/UTC' }
        );

        // Apply Bank district weekly interest every Monday at 00:01 UTC
        cron.schedule('1 0 * * 1', () =>
            runJob('schedulerService', 'applyBankInterest', () => applyBankInterest(client)),
            { timezone: 'Etc/UTC' }
        );

        // Announce last hour's micro-competition winners and reset at the top of every hour
        cron.schedule('0 * * * *', () =>
            runJob('schedulerService', 'announceHourlyWinners', () => announceHourlyWinners(client))
        );

        // Dynamic shop pricing recalculation — per-guild gated by lastRecalcAt + recalcMinutes
        cron.schedule('*/15 * * * *', () =>
            runJob('schedulerService', 'recalcShopPrices', () => recalcShopPrices(client))
        );

        // Ranked duel season rollover — check every 10 minutes for expired seasons
        cron.schedule('*/10 * * * *', () =>
            runJob('schedulerService', 'resolveRankedSeasons', () => resolveRankedSeasons(client))
        );

        // Return items from expired market listings before the TTL index deletes them
        cron.schedule('*/10 * * * *', () =>
            runJob('schedulerService', 'returnExpiredMarketListings', () => returnExpiredMarketListings())
        );

        // Server Newspaper delivery — check every hour for guilds scheduled to receive their edition
        cron.schedule('0 * * * *', () =>
            runJob('schedulerService', 'postScheduledNewspapers', () => postScheduledNewspapers(client)),
            { timezone: 'Etc/UTC' }
        );

        // Reconcile any jackpot wins where pool was reset but winner was never credited
        try {
            const Guild = require('../models/Guild');
            const Transaction = require('../models/Transaction');
            const claimToken = `${process.pid}-${Date.now()}`;
            let candidateGuild;
            // Process one guild at a time; re-query each iteration to avoid stale data
            while ((candidateGuild = await Guild.findOneAndUpdate(
                {
                    'casinoJackpot.lastWinnerId':  { $ne: null },
                    'casinoJackpot.lastWonAmount': { $gt: 0 },
                    'casinoJackpot.claimToken':    { $in: [null, claimToken] },
                },
                { $set: { 'casinoJackpot.claimToken': claimToken } },
                { new: true }
            )) !== null) {
                const { lastWinnerId, lastWonAmount, lastWonAt } = candidateGuild.casinoJackpot;
                const guildId = candidateGuild.guildId;
                let creditSucceeded = false;
                try {
                    const credited = await Transaction.findOne({
                        userId:  lastWinnerId,
                        guildId,
                        type:    'casino_jackpot',
                        amount:  lastWonAmount,
                        ...(lastWonAt ? { createdAt: { $gte: lastWonAt } } : {}),
                    }).lean();
                    if (!credited) {
                        const updatedUser = await User.findOneAndUpdate(
                            { userId: lastWinnerId, guildId },
                            { $inc: { balance: lastWonAmount } },
                            { new: true }
                        );
                        if (updatedUser) {
                            logTransaction({ userId: lastWinnerId, guildId, type: 'casino_jackpot', amount: lastWonAmount, balance: updatedUser.balance, note: 'jackpot reconciliation on restart' });
                            console.log(`[READY] Reconciled jackpot payout of ${lastWonAmount} to ${lastWinnerId} in guild ${guildId}`);
                            creditSucceeded = true;
                        }
                    } else {
                        creditSucceeded = true; // already paid, just clear
                    }
                } catch (innerErr) {
                    console.error(`[READY] Jackpot credit failed for guild ${guildId}:`, innerErr);
                }
                if (creditSucceeded) {
                    await Guild.updateOne(
                        { _id: candidateGuild._id },
                        { $set: { 'casinoJackpot.lastWinnerId': null, 'casinoJackpot.lastWonAmount': null, 'casinoJackpot.claimToken': null } }
                    );
                } else {
                    // Release lock without clearing recovery fields so next restart can retry
                    await Guild.updateOne(
                        { _id: candidateGuild._id },
                        { $set: { 'casinoJackpot.claimToken': null } }
                    );
                    break; // avoid spinning on a persistently failing guild
                }
            }
        } catch (err) {
            console.error('[READY] Jackpot reconciliation failed:', err);
        }

        // Refund any bets that were deducted during a crash game that was interrupted by a restart
        try {
            const pending = await User.find({ pendingCrashRefund: { $gt: 0 } }).lean();
            if (pending.length > 0) {
                for (const u of pending) {
                    await User.findOneAndUpdate(
                        { _id: u._id },
                        [{ $inc: { balance: '$pendingCrashRefund' } }, { $set: { pendingCrashRefund: 0 } }]
                    );
                    logTransaction({ userId: u.userId, guildId: u.guildId, type: 'crash_refund', amount: u.pendingCrashRefund, balance: u.balance + u.pendingCrashRefund, note: 'bot restart refund' });
                }
                console.log(`[READY] Refunded crash bets for ${pending.length} user(s)`);
            }
        } catch (err) {
            console.error('[READY] Crash refund sweep failed:', err);
        }

        console.log('[READY] Background services started');
    }
};
