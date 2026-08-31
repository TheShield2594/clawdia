'use strict';

// The dashboard, as its own process (#876).
//
// On shard 0 a single Node process ran the Discord gateway, this Express app,
// full-collection aggregations, canvas rendering, AI provider calls and every
// cron job. A CPU-heavy dashboard request delayed gateway heartbeats for every
// guild the bot was in, and a fault in a route reached the process-level guards
// in src/index.js, which exit — so a bad dashboard page was a bot-wide outage.
//
// Everything needed to separate them was already in place: `createApp` takes an
// injected `bot` facade, that facade is id-in / plain-data-out, and the session
// store is injected too. What was missing was a second entry point and a
// transport. This is the entry point; src/bot/remoteGateway.js is the
// transport.
//
// What this process does NOT do, and that is the point: it holds no gateway
// connection, registers no commands, runs no cron jobs, and has no Discord
// client to speak of. It talks to Mongo for the data it owns and to the bot
// process for the handful of things only a gateway can answer.
//
// Run it with `npm run start:dashboard`, or bring up the compose service:
//
//     docker compose --profile split-dashboard up -d

require('dotenv').config();
require('../config/fileSecrets').loadFileSecrets();
const { assertEnv, DASHBOARD_REQUIRED_ENV } = require('../config/validateEnv');
assertEnv({ label: 'DASHBOARD', required: DASHBOARD_REQUIRED_ENV });
require('../utils/logger').installConsoleBridge();

const { connect, connection } = require('mongoose');

const { createRemoteBotGateway } = require('../bot/remoteGateway');
const { createApp, listen } = require('./server');

async function connectDatabase() {
    const masked = (process.env.MONGODB_URI || '').replace(/\/\/[^@]*@/, '//***@');
    try {
        await connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
        console.log('[DATABASE] Connected to MongoDB');
    } catch (error) {
        console.error(`[DATABASE] Failed to connect to ${masked}:`, error.message);
        process.exit(1);
    }

    connection.on('disconnected', () => console.warn('[DATABASE] Disconnected from MongoDB'));
    connection.on('reconnected', () => console.log('[DATABASE] Reconnected to MongoDB'));
    connection.on('error', err => console.error('[DATABASE] Connection error:', err.message));
}

async function main() {
    // Migrations are deliberately not run here. They are singleton work owned by
    // shard 0 of the bot (src/index.js), and a second process racing the same
    // forward-only schema change is a different failure every time. This one
    // connects to a database the bot has already migrated.
    await connectDatabase();

    // Fails loudly and immediately on a missing URL or token, before a port is
    // bound: a dashboard that starts and then 500s every page because it cannot
    // reach the bot is worse than one that refuses to start.
    const bot = createRemoteBotGateway();

    const server = listen(createApp({ bot }));

    const shutdown = async signal => {
        console.log(`[SHUTDOWN] Received ${signal}. Shutting down the dashboard...`);
        try {
            await new Promise(resolve => server.close(resolve));
            await connection.close();
            console.log('[SHUTDOWN] Clean exit.');
        } catch (err) {
            console.error('[SHUTDOWN] Error during shutdown:', err);
        }
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // This process has no gateway connection to lose, so the calculus that makes
    // src/index.js exit on a spike of unhandled rejections does not apply: the
    // worst case here is one broken page, and exiting turns that into no
    // dashboard at all. Log and keep serving.
    process.on('unhandledRejection', err =>
        console.error('[PROCESS] Unhandled promise rejection:', err));
    process.on('uncaughtException', err =>
        console.error('[PROCESS] Uncaught exception:', err));
}

if (require.main === module) {
    main().catch(err => {
        console.error('[STARTUP] The dashboard failed to start:', err);
        process.exit(1);
    });
}

module.exports = { main };
