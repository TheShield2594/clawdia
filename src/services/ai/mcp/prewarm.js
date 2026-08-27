'use strict';

const Guild = require('../../../models/Guild');
const { getMcpServers } = require('../../../config/mcpServers');
const { prewarmMcpServers } = require('./toolkit');

/**
 * Fill the MCP tool-list cache at startup, before anybody asks.
 *
 * Discovery is a handshake and a `tools/list` per server, and the cache that
 * holds the answer is process-local — so a restart puts that cost back on
 * whoever sends the first message afterwards, which is the one moment a bot is
 * least able to explain itself. Everything the connection pool needs is
 * knowable in advance: the servers are stored on the guild, and nothing about
 * them depends on what the message says.
 *
 * Best-effort in every direction. A server that is down is skipped and dialled
 * again the ordinary way on the first message; a database that is not up yet
 * costs a warm cache and nothing else.
 */

// Guilds warmed per pass. A deployment with MCP configured everywhere would
// otherwise open every connection it has ever been given inside one tick of
// startup, which is the opposite of being polite to somebody else's server —
// and the pool deduplicates by (url, token), so the shared servers in the
// operator's config file are dialled once however many guilds list them.
const MAX_GUILDS = 50;

// Started after the gateway is up, so it is competing with command deployment
// and the scheduler's first minute. A short delay puts it behind them.
const START_DELAY_MS = 5000;

// Whether the config file has anything in it. Read through the same loader the
// request path uses, and never fatal: an unreadable file is a problem for the
// first message to report, not for a cache warm-up to crash on.
function operatorServers() {
    try {
        return getMcpServers().length > 0;
    } catch {
        return false;
    }
}

/**
 * Every guild this process serves that has MCP servers stored.
 *
 * Filtered against the client's own guild cache because a shard is only
 * delivered its own guilds' messages, so warming another shard's connections
 * would spend a handshake on a conversation this process will never see.
 */
async function guildsToWarm(client) {
    // Servers in the operator's config file belong to every AI-enabled guild,
    // so when there are any, having none of your own is not a reason to be
    // skipped. The connection pool deduplicates by (url, token), so the extra
    // guilds cost a cache lookup each rather than a handshake.
    const query = { 'ai.enabled': true };
    if (!operatorServers()) query['ai.mcpServers.0'] = { $exists: true };

    const stored = await Guild.find(query, { guildId: 1, 'ai.mcpServers': 1 }).lean();

    return stored
        .filter(guild => client?.guilds?.cache?.has(guild.guildId))
        .slice(0, MAX_GUILDS);
}

async function warmNow(client) {
    let guilds;
    try {
        guilds = await guildsToWarm(client);
    } catch (err) {
        console.warn(`[MCP] prewarm could not read guild settings: ${err.message}`);
        return 0;
    }
    if (!guilds.length) return 0;

    let connections = 0;
    // One guild at a time. Each call fans out across that guild's own servers,
    // and the point of this is to be finished before the first message rather
    // than to be finished quickly.
    for (const guild of guilds) {
        connections += await prewarmMcpServers(guild.ai?.mcpServers || []);
    }

    if (connections) {
        console.log(`[MCP] Pre-warmed ${connections} connection${connections === 1 ? '' : 's'} for ${guilds.length} guild${guilds.length === 1 ? '' : 's'}`);
    }
    return connections;
}

/** Scheduler starter: kick the warm-up off and get out of the way. */
function startMcpPrewarm(client) {
    const timer = setTimeout(() => {
        warmNow(client).catch(err => console.warn(`[MCP] prewarm failed: ${err.message}`));
    }, START_DELAY_MS);
    // Nothing here is worth holding the process open for.
    timer.unref?.();
    return timer;
}

module.exports = { startMcpPrewarm, warmNow, MAX_GUILDS, START_DELAY_MS };
