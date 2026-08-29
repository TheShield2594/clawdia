const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const { connect, connection } = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
// Resolves any <NAME>_FILE variable into <NAME>, so secrets can be mounted as
// files (docker secrets) instead of being readable via `docker inspect`. Runs
// straight after dotenv so .env can set the *_FILE paths too, and before
// anything reads process.env.
require('./config/fileSecrets').loadFileSecrets();

// Validate the whole configuration before doing anything else — in particular
// before connectDatabase() and runMigrations(), which is the ordering #639 was
// about. The DASHBOARD_URL and SESSION_SECRET rules used to live in
// dashboard/server.js, which starts *after* the database has been connected and
// migrated, so a deploy that was going to be rejected for a http:// callback URL
// was rejected only once it had already written to the database. Migrations have
// no rollback path, so "crash-loop before touching anything" is the only safe
// order. Every rule now lives in config/validateEnv.js; this exits on the first
// call if any of them fail.
require('./config/validateEnv').assertEnv({ label: 'STARTUP' });

// Route every `console.*` in the process through the pino logger, so the ~660
// existing call sites get levels, timestamps, a `component` taken from their
// `[TAG]` prefix, and JSON output under NODE_ENV=production (#647). Installed
// here rather than inside utils/logger.js so that requiring the logger — which
// tests and `npm run deploy` do — never silently replaces the console. This is
// the first thing after the environment is known and before anything below
// logs, so no line escapes it. See LOG_LEVEL / LOG_FORMAT in the README.
require('./utils/logger').installConsoleBridge();
const { reportAndExit, reportError, isConfigured: errorSinkConfigured } = require('./utils/errorReporter');

const health = require('./health');
const { makeCache, sweepers } = require('./utils/cacheOptions');
const { isPrimaryShard, shardTag } = require('./utils/sharding');
const { loadCommandModules } = require('./utils/commandLoader');
const { startCooldownSweeper } = require('./utils/commandCooldowns');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildWebhooks
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],

    // Member/user/ban caches are unbounded by default; see cacheOptions.js.
    makeCache,
    sweepers,
});

client.commands = new Collection();
// The hot half of the cooldown store: `guildId:bucket -> Map(userId ->
// startedAt)`, read on every interaction without a database round trip. Short
// cooldowns live here and nowhere else; from 15 minutes up the same entry is
// also written to the User document, so a restart no longer hands the window
// back (#621). Entries expire by being compared against the clock when read,
// and the sweeper below drops the ones nobody returns for — see
// utils/commandCooldowns.js.
//
// None of it is what *enforces* a cooldown: every command that pays out claims
// its own window atomically in Mongo (`lastWork`/`lastDaily`/`lastCrime`/
// `lastRob` in the update filter, `data.lastCast` on GrindProfile for the
// grinds), which is what a second process would still be bound by. See
// tests/economyCooldownClaims.test.js, which holds that line.
client.cooldowns = new Collection();
startCooldownSweeper(client);

async function loadCommands() {
    // One walk, shared with the deploy and the cap guard — see
    // utils/commandLoader.js. The deploy at ready reuses this collection
    // rather than re-requiring the tree (#607).
    const { commands, failures } = loadCommandModules();

    for (const { command } of commands) {
        client.commands.set(command.data.name, command);
        console.log(`[COMMAND] Loaded ${command.data.name}`);
    }

    // Fatal rather than a warning, because the deploy now publishes exactly
    // what is in this collection. A file that quietly fails to load here would
    // otherwise unregister a working command in production, with the only
    // signal a line in the startup log nobody reads.
    if (failures.length) {
        console.error(`[STARTUP] ${failures.length} command file(s) failed to load:`);
        for (const f of failures) console.error(`  - ${f}`);
        console.error('[STARTUP] Refusing to start with an incomplete command set.');
        process.exit(1);
    }
}

async function loadEvents() {
    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        const event = require(filePath);

        // Wrap every handler so a rejection inside one becomes a logged error
        // rather than an unhandled rejection. Without this a single throwing
        // handler counts toward the REJECTION_LIMIT guard below, so a user who
        // can reliably trigger one can force the process to exit.
        const invoke = (...args) => {
            try {
                const result = event.execute(...args, client);
                if (result && typeof result.then === 'function') {
                    result.catch(err => console.error(`[EVENT] Unhandled error in ${event.name} handler:`, err));
                }
            } catch (err) {
                console.error(`[EVENT] Unhandled error in ${event.name} handler:`, err);
            }
        };

        if (event.once) {
            client.once(event.name, invoke);
        } else {
            client.on(event.name, invoke);
        }
        console.log(`[EVENT] Loaded ${event.name}`);
    }
}

async function connectDatabase() {
    // M6: Mask the entire userinfo section (username:password) in log output.
    const maskedUri = (process.env.MONGODB_URI || '').replace(/\/\/[^@]*@/, '//***@');
    try {
        await connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
        });
        console.log('[DATABASE] Connected to MongoDB');
    } catch (error) {
        console.error(`[DATABASE] Failed to connect to ${maskedUri}:`, error.message);
        process.exit(1);
    }

    connection.on('disconnected', () => console.warn('[DATABASE] Disconnected from MongoDB'));
    connection.on('reconnected', () => console.log('[DATABASE] Reconnected to MongoDB'));
    connection.on('error', err => console.error('[DATABASE] Connection error:', err.message));
}

async function startDashboard() {
    // The dashboard binds a TCP port, so it is singleton work: under sharding
    // every shard is its own process and N of them would fight over one port.
    // Shard 0 runs it; the rest skip it. Unsharded, `isPrimaryShard` is true and
    // nothing changes. See src/utils/sharding.js (#732).
    if (!isPrimaryShard(client)) {
        console.log(`${shardTag(client)}[DASHBOARD] Not the primary shard — dashboard not started.`);
        return;
    }
    // Nothing the dashboard does at construction time is worth the gateway
    // (#616). `listen` already holds this line for a socket that cannot bind —
    // "the dashboard being unreachable is bad; the bot leaving every guild
    // because of it is worse" — but the half in front of it did not: a throw out
    // of `createApp` propagated through startBot() to the `process.exit(1)` at
    // the bottom of this file, and the bot never logged in at all.
    //
    // That is not hypothetical. A connect-mongo major bump changed the shape of
    // its export, and the one line that builds the session store took the whole
    // bot down on boot with `MongoStore.create is not a function` — a dashboard
    // detail, on a path that had nothing to do with Discord (see
    // dashboard/lib/sessionStore.js).
    //
    // Configuration is deliberately not covered by this: config/validateEnv.js
    // runs before the database is even connected and exits there, so a bad
    // DASHBOARD_URL is still a refusal to start rather than a bot that quietly
    // serves Discord with no dashboard.
    try {
        const dashboard = require('./dashboard/server');
        dashboard.start(client);
    } catch (err) {
        console.error('[DASHBOARD] Failed to start. The bot continues without it:', err);
    }
}

// Graceful shutdown: close DB and destroy Discord client before exiting
async function shutdown(signal) {
    console.log(`[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);
    const { stopScheduler } = require('./services/scheduler');
    stopScheduler();
    try {
        await client.destroy();
        await connection.close();
        console.log('[SHUTDOWN] Clean exit.');
    } catch (err) {
        console.error('[SHUTDOWN] Error during shutdown:', err);
    }
    process.exit(0);
}

async function startBot() {
    await connectDatabase();

    // Migrations are singleton work too: N shards racing the same schema change
    // is a different failure every time. Shard 0 runs them before it logs in;
    // the others wait for the flag it sets rather than running their own.
    const { runMigrations, waitForMigrations } = require('./migrations/runner');
    if (isPrimaryShard(client)) {
        await runMigrations();
    } else {
        // Not "skip and carry on": serving traffic against a half-migrated
        // database is the failure this ordering exists to prevent.
        console.log(`${shardTag(client)}[MIGRATIONS] Shard 0 owns migrations — waiting for them.`);
        const ready = await waitForMigrations();
        if (!ready) {
            console.error(`${shardTag(client)}[STARTUP] Migrations did not complete — refusing to start.`);
            process.exit(1);
        }
    }

    await loadCommands();
    await loadEvents();
    await startDashboard();

    // All background services, scheduled jobs, and presence rotation start
    // from the clientReady handler in events/ready.js via services/scheduler.

    // Await the login so a bad/revoked token is a hard startup failure. Left
    // unawaited it rejects into the unhandledRejection handler, which just logs
    // once — leaving a half-alive process serving the dashboard with no gateway
    // connection and a "healthy" status.
    await client.login(process.env.DISCORD_TOKEN);
}

// --- Process-level reliability guards ---

// Track repeated unhandled rejections; exit if they spike (indicates a stuck state)
const REJECTION_WINDOW_MS = 60_000;
const REJECTION_LIMIT = 10;
const recentRejections = [];

// Reported to ERROR_WEBHOOK_URL as well as logged, when one is set. A line in
// a 250 MB rolling text stream that nothing watches is how a 04:00 crash-loop
// stayed invisible for days (#647). With no sink configured every path below
// behaves exactly as it did before, exit timing included.
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
        reportAndExit('unhandledRejection', error, {
            extra: { rejectionsInWindow: recentRejections.length, windowMs: REJECTION_WINDOW_MS },
        });
        return;
    }
    // Below the limit the process keeps running, so there is nothing to wait
    // for — fire the report and let it finish on its own.
    if (errorSinkConfigured()) {
        reportError('unhandledRejection', error).catch(() => {});
    }
});

process.on('uncaughtException', (error) => {
    health.incrementUncaughtExceptions();
    console.error('[PROCESS] Uncaught exception:', error);
    // uncaughtException leaves the process in an undefined state; always exit.
    // reportAndExit exits synchronously when no sink is configured, and is
    // bounded by ERROR_REPORT_TIMEOUT_MS when one is.
    reportAndExit('uncaughtException', error);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startBot().catch(err => {
    console.error('[STARTUP] Fatal error during bot startup:', err);
    process.exit(1);
});
