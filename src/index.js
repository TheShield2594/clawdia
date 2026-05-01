const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { connect } = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

client.commands = new Collection();
client.cooldowns = new Collection();
client.musicQueues = new Map();

async function loadCommands() {
    const foldersPath = path.join(__dirname, 'commands');
    const commandFolders = fs.readdirSync(foldersPath);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);

            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
                console.log(`[COMMAND] Loaded ${command.data.name}`);
            } else {
                console.log(`[WARNING] Command at ${filePath} is missing required "data" or "execute" property.`);
            }
        }
    }
}

async function loadEvents() {
    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        const event = require(filePath);

        if (event.once) {
            client.once(event.name, (...args) => event.execute(...args, client));
        } else {
            client.on(event.name, (...args) => event.execute(...args, client));
        }
        console.log(`[EVENT] Loaded ${event.name}`);
    }
}

async function connectDatabase() {
    try {
        await connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('[DATABASE] Connected to MongoDB');
    } catch (error) {
        console.error('[DATABASE] Failed to connect:', error);
        process.exit(1);
    }
}

async function startDashboard() {
    const dashboard = require('./dashboard/server');
    dashboard.start(client);
}

async function startBot() {
    await connectDatabase();
    await loadCommands();
    await loadEvents();
    await startDashboard();

    client.once('ready', () => {
        const { startSummaryService } = require('./services/summaryService');
        startSummaryService(client);

        const { startSlaMonitor } = require('./services/caseService');
        startSlaMonitor(client);

        const { startQuestService } = require('./services/questService');
        startQuestService();

        const { scheduleActivePollExpirations } = require('./commands/utility/poll');
        scheduleActivePollExpirations(client);

        const { startDailyBibleService } = require('./services/dailyBibleService');
        startDailyBibleService(client);
    });

    client.login(process.env.DISCORD_TOKEN);
}

startBot().catch(console.error);

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});