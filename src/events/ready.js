const cron = require('node-cron');
const { deployCommands } = require('../utils/commandDeployer');
const { checkRssFeeds, scheduleDailyNews } = require('../services/rssService');
const { checkReminders } = require('../services/reminderService');
const { checkGiveaways } = require('../services/giveawayService');
const { checkTempVoice } = require('../services/tempVoiceService');
const { runJob } = require('../utils/jobRunner');

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
            activities: [{ name: '/help | UltraBot', type: 0 }],
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

        console.log('[READY] Background services started');
    }
};
