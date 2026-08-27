'use strict';

const { McpHttpClient } = require('./client');
const { entryFor, primeList } = require('./connections');
const { isToolEnabled, needsConfirmation, toolAnnotations } = require('../../../config/mcpServers');

// "Does this connection work, and what would it let the model do?"
//
// Asked from two places — the dashboard's Test button and `/ai mcp` in Discord
// — and it has to give the same answer to both, because an admin who tests from
// the panel and then checks from a channel is checking the same thing. The bot
// does the handshake itself rather than asking a model to: no provider key is
// involved, no tokens are spent, and the answer is about the server rather than
// about whatever a model said back.

// Enough names to fill in an allow, block or approval list from; past that the
// list stops being something a person reads.
const MAX_TOOLS_REPORTED = 50;

/** The tail of the connected message: what else this server has, if anything. */
function extras(resourceCount, promptCount) {
    const bits = [];
    if (resourceCount) bits.push(`${resourceCount} resource${resourceCount === 1 ? '' : 's'}`);
    if (promptCount) bits.push(`${promptCount} prompt${promptCount === 1 ? '' : 's'}`);
    return bits.length ? `. It also publishes ${bits.join(' and ')}.` : '.';
}

// The three lists this inspection fetched, handed to the shared connection pool
// so the next caller finds them already there. Never fatal: a warm cache is a
// convenience, and a test that reported a working server has done its job.
// A null value is a list this connection did not actually get; primeList skips
// it rather than caching an empty one.
function primeLists(server, lists) {
    try {
        const entry = entryFor(server);
        for (const [kind, value] of Object.entries(lists)) primeList(entry, kind, value);
    } catch (err) {
        console.warn(`[MCP] could not cache "${server.name}" discovery: ${err.message}`);
    }
}

/**
 * Connect to one resolved server and report what it offers.
 *
 * Never throws for a server-side problem: a failed connection is the expected
 * outcome of a test, not a fault, and what the server said is the useful part
 * of it. Only a caller passing something unusable gets an exception.
 *
 * @param {object} server one entry from resolveMcpServers()
 * @param {object} [options]
 * @param {string} [options.confirmMode] the guild's approval policy
 * @returns {Promise<object>} { success, message, tools, ... }
 */
async function inspectServer(server, { confirmMode } = {}) {
    let client = null;
    try {
        const grant = server.connection.oauth;
        client = new McpHttpClient({
            url: server.connection.url,
            authorizationToken: server.connection.authorizationToken,
            label: server.name,
            // So a test of an OAuth connection tests the credential the chat
            // path would actually use, refreshed if it is due (#796) — rather
            // than reporting a 401 an admin would then go looking for.
            getAccessToken: grant
                ? ({ force }) => require('./oauthStore').accessTokenFor(grant.guildId, grant.server, { force })
                : null
        });

        const tools = await client.listTools();
        // The other two halves of the protocol, asked for only when the server
        // said in its handshake that it has them. An admin filling in the
        // Connections panel wants to know a server publishes documents or
        // prompt templates as much as they want the tool list — those are the
        // two switches under it.
        const [resourcesRead, promptsRead] = await Promise.allSettled([
            client.listResources(),
            client.listPrompts()
        ]);
        // A list the server refused is reported as empty — the connection works,
        // which is what a test is asking about — but it is emphatically not the
        // same as a server that has none, so it is not cached. Priming an empty
        // list from a request that failed would have the chat path believe for
        // five minutes that this server publishes no documents.
        const answered = read => (read.status === 'fulfilled' ? read.value : null);

        // A test is a full discovery run whose answer was about to be thrown
        // away. The pool is keyed by (url, token), so what this connection just
        // learned is exactly what the guild's next message would have gone and
        // asked for — an admin who saves a server and then uses it in a channel
        // now pays for the handshake once rather than twice.
        primeLists(server, {
            tools,
            resources: answered(resourcesRead),
            prompts: answered(promptsRead)
        });

        const resources = answered(resourcesRead) || [];
        const prompts = answered(promptsRead) || [];

        const described = tools.slice(0, MAX_TOOLS_REPORTED).map(tool => ({
            name: tool.name,
            enabled: isToolEnabled(server.toolset, tool.name),
            confirm: needsConfirmation(confirmMode, server.toolset, tool),
            annotations: toolAnnotations(tool)
        }));

        const enabled = tools.filter(tool => isToolEnabled(server.toolset, tool.name));
        const confirming = enabled.filter(tool => needsConfirmation(confirmMode, server.toolset, tool));
        const serverName = client.serverInfo?.name;

        return {
            success: true,
            needsOAuth: false,
            wwwAuthenticate: null,
            message: `Connected${serverName ? ` to ${serverName}` : ''} — ${tools.length} tool${tools.length === 1 ? '' : 's'} offered, ` +
                `${enabled.length} enabled by your filters` +
                (confirming.length ? `, ${confirming.length} needing approval` : '') +
                extras(resources.length, prompts.length),
            serverName: serverName || null,
            toolCount: tools.length,
            resourceCount: resources.length,
            promptCount: prompts.length,
            enabledCount: enabled.length,
            confirmCount: confirming.length,
            tools: described
        };
    } catch (error) {
        if (!error?.status) console.error(`[MCP] inspect "${server.name}" failed:`, error?.message || error);
        return {
            success: false,
            message: error?.message || 'Unknown error',
            // A 401 carrying a Bearer challenge is not a wrong token, it is a
            // server asking for an OAuth login (#796). Reported separately from
            // the message so the dashboard can offer Connect rather than making
            // an admin read the difference out of an error string, and the
            // challenge itself comes along because `resource_metadata` on it is
            // where discovery starts.
            needsOAuth: error?.needsOAuth === true,
            wwwAuthenticate: error?.wwwAuthenticate || null,
            toolCount: 0,
            resourceCount: 0,
            promptCount: 0,
            enabledCount: 0,
            confirmCount: 0,
            tools: []
        };
    } finally {
        // The handshake opened a session the far side is holding; a test that
        // leaves one behind on every click is a slow leak on somebody's server.
        if (client) client.close().catch(() => {});
    }
}

module.exports = { inspectServer, MAX_TOOLS_REPORTED };
