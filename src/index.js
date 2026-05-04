const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { connect, connection } = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const health = require('./health');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildWebhooks
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
            serverSelectionTimeoutMS: 10000,
        });
        console.log('[DATABASE] Connected to MongoDB');
    } catch (error) {
        console.error('[DATABASE] Failed to connect:', error);
        process.exit(1);
    }

    connection.on('disconnected', () => console.warn('[DATABASE] Disconnected from MongoDB'));
    connection.on('reconnected', () => console.log('[DATABASE] Reconnected to MongoDB'));
    connection.on('error', err => console.error('[DATABASE] Connection error:', err));
}

async function startDashboard() {
    const dashboard = require('./dashboard/server');
    dashboard.start(client);
}

// Graceful shutdown: close DB and destroy Discord client before exiting
async function shutdown(signal) {
    console.log(`[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);
    try {
        client.destroy();
        await connection.close();
        console.log('[SHUTDOWN] Clean exit.');
    } catch (err) {
        console.error('[SHUTDOWN] Error during shutdown:', err);
    }
    process.exit(0);
}

async function startBot() {
    await connectDatabase();

    // Run pending schema migrations before the bot starts accepting traffic
    const { runMigrations } = require('./migrations/runner');
    await runMigrations();

    await loadCommands();
    await loadEvents();
    await startDashboard();

    client.once('ready', () => {
        const { deployCommands } = require('./utils/commandDeployer');
        deployCommands(process.env.CLIENT_ID, process.env.DISCORD_TOKEN)
            .then(count => console.log(`[COMMANDS] Deployed ${count} slash commands`))
            .catch(err => console.error('[COMMANDS] Failed to deploy slash commands:', err));

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

// --- Process-level reliability guards ---

// Track repeated unhandled rejections; exit if they spike (indicates a stuck state)
const REJECTION_WINDOW_MS = 60_000;
const REJECTION_LIMIT = 10;
const recentRejections = [];

process.on('unhandledRejection', (error) => {
    health.incrementUnhandledRejections();
    console.error('[PROCESS] Unhandled promise rejection:', error);

    const now = Date.now();
    recentRejections.push(now);
    // Evict entries outside the window
    while (recentRejections.length && recentRejections[0] < now - REJECTION_WINDOW_MS) {
        recentRejections.shift();
    }
    if (recentRejections.length >= REJECTION_LIMIT) {
        console.error(`[PROCESS] ${REJECTION_LIMIT} unhandled rejections in ${REJECTION_WINDOW_MS / 1000}s — forcing exit.`);
        process.exit(1);
    }
});

process.on('uncaughtException', (error) => {
    health.incrementUncaughtExceptions();
    console.error('[PROCESS] Uncaught exception:', error);
    // uncaughtException leaves the process in an undefined state; always exit
    process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startBot().catch(err => {
    console.error('[STARTUP] Fatal error during bot startup:', err);
    process.exit(1);
});
