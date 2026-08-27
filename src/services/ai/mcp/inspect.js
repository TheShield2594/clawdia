'use strict';

const { McpHttpClient } = require('./client');
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
        client = new McpHttpClient({
            url: server.connection.url,
            authorizationToken: server.connection.authorizationToken,
            label: server.name
        });

        const tools = await client.listTools();
        // The other two halves of the protocol, asked for only when the server
        // said in its handshake that it has them. An admin filling in the
        // Connections panel wants to know a server publishes documents or
        // prompt templates as much as they want the tool list — those are the
        // two switches under it.
        const [resources, prompts] = await Promise.all([
            client.listResources().catch(() => []),
            client.listPrompts().catch(() => [])
        ]);
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
