const cron = require('node-cron');
const { deployCommands } = require('../utils/commandDeployer');
const { checkRssFeeds, scheduleDailyNews } = require('../services/rssService');
const { checkReminders } = require('../services/reminderService');
const { checkGiveaways } = require('../services/giveawayService');
const { checkTempVoice } = require('../services/tempVoiceService');
const { checkBirthdays } = require('../services/birthdayService');
const { checkSeasonalEvents } = require('../services/seasonalEventService');
const { runJob } = require('../utils/jobRunner');
const User = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');

module.exports = {
    name: 'ready',
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
