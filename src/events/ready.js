const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { checkRssFeeds, scheduleDailyNews } = require('../services/rssService');
const { checkReminders } = require('../services/reminderService');
const { checkGiveaways } = require('../services/giveawayService');
const { checkTempVoice } = require('../services/tempVoiceService');

async function deployCommands(clientId) {
    const commands = [];
    const foldersPath = path.join(__dirname, '../commands');

    for (const folder of fs.readdirSync(foldersPath)) {
        const commandsPath = path.join(foldersPath, folder);
        for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
            const command = require(path.join(commandsPath, file));
            if ('data' in command && 'execute' in command) {
                commands.push(command.data.toJSON());
            }
        }
    }

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    return commands.length;
}

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`[READY] Logged in as ${client.user.tag}`);
        console.log(`[READY] Serving ${client.guilds.cache.size} guilds`);

        try {
            const count = await deployCommands(client.user.id);
            console.log(`[READY] Deployed ${count} slash commands`);
        } catch (error) {
            console.error('[READY] Failed to deploy slash commands:', error);
        }

        client.user.setPresence({
            activities: [{ name: '/help | UltraBot', type: 0 }],
            status: 'online'
        });

        cron.schedule('*/5 * * * *', async () => {
            await checkRssFeeds(client);
        });

        cron.schedule('* * * * *', async () => {
            await checkReminders(client);
        });

        scheduleDailyNews(client);

        cron.schedule('* * * * *', async () => {
            await checkGiveaways(client);
        });

        cron.schedule('*/2 * * * *', async () => {
            await checkTempVoice(client);
        });

        console.log('[READY] Background services started');
    }
};
