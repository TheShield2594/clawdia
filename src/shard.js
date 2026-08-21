'use strict';

// Sharding entry point (#732).
//
// `npm start` runs src/index.js directly — one process, one gateway connection,
// which is correct for every deployment below roughly 2,000 guilds and is what
// Clawdia has always done. This file is the other way in: `npm run start:sharded`
// spawns one src/index.js per shard under a ShardingManager.
//
// It is deliberately thin. The interesting part of sharding this bot is not
// spawning processes, it is what stops being true once there is more than one —
// and that is written down in src/utils/sharding.js, which both entry points
// share. In particular:
//
//   - Guild-scoped session state (crash lobbies, heists, syndicate heists, the
//     raid join window) is safe, because Discord routes a guild's events to
//     exactly one shard. That is the affinity guarantee #732 asked about.
//   - Singleton work is NOT safe and is gated on `isPrimaryShard()` at its
//     bootstrap site: the dashboard would otherwise have N processes fighting
//     for one port, and every cron job would fire once per shard.
//
// Set SHARD_COUNT to pin a number; leave it unset for Discord's recommendation.

require('dotenv').config();

const path = require('path');
const { ShardingManager } = require('discord.js');

const REQUIRED_ENV = ['DISCORD_TOKEN', 'CLIENT_ID', 'MONGODB_URI', 'SESSION_SECRET', 'CLIENT_SECRET'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
    console.error(`[SHARD] Missing required environment variables: ${missingEnv.join(', ')}`);
    process.exit(1);
}

function resolveShardCount() {
    const pinned = Number(process.env.SHARD_COUNT);
    if (Number.isInteger(pinned) && pinned > 0) return pinned;
    // 'auto' asks the gateway what it wants. Anything else and the manager would
    // read the string as a number and spawn NaN shards.
    return 'auto';
}

const manager = new ShardingManager(path.join(__dirname, 'index.js'), {
    token: process.env.DISCORD_TOKEN,
    totalShards: resolveShardCount(),
    // The child reads its own identity from `client.shard`, but the singleton
    // gate runs before login — so the count is passed down as an env var too,
    // and `shardCount()` falls back to it.
    respawn: true,
});

manager.on('shardCreate', shard => {
    console.log(`[SHARD] Launched shard ${shard.id}`);
    shard.on('death', () => console.error(`[SHARD] Shard ${shard.id} died`));
    shard.on('error', err => console.error(`[SHARD] Shard ${shard.id} error:`, err.message));
});

manager.spawn()
    .then(shards => {
        console.log(`[SHARD] ${shards.size} shard(s) spawned.`);
        // Only shard 0 runs the dashboard and the cron scheduler; see
        // src/utils/sharding.js for why, and index.js/ready.js for the gates.
        console.log('[SHARD] Dashboard and scheduled jobs run on shard 0 only.');
    })
    .catch(err => {
        console.error('[SHARD] Failed to spawn shards:', err);
        process.exit(1);
    });
