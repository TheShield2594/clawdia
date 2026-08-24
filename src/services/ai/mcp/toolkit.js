'use strict';

const { resolveMcpServers, isToolEnabled } = require('../../../config/mcpServers');
const { McpHttpClient, McpError } = require('./client');

/**
 * The provider-neutral half of MCP support.
 *
 * Anthropic takes a server list and does the rest itself. Every other provider
 * takes *tools* — a name, a description and a JSON Schema — and hands back calls
 * to make. This module turns the guild's MCP servers into that shape once, so a
 * provider module only has to translate the same three fields into its own wire
 * format and run the loop.
 *
 * Connections and tool lists are cached per (url, token): a Discord
 * conversation is many requests against the same handful of servers, and
 * re-running the handshake for each one would add a round trip per message for
 * a list that changes about never.
 */

// Tool lists are stable in practice; five minutes picks up a server that gained
// a tool without asking it on every message.
const TOOL_LIST_TTL_MS = 5 * 60 * 1000;

// A server that is down should not be dialled again on every single message,
// but it should recover on its own within a conversation.
const FAILURE_TTL_MS = 60 * 1000;

// Sessions cost the server memory. An idle one is closed rather than held open
// for a guild that used a tool once this afternoon.
const SESSION_IDLE_MS = 10 * 60 * 1000;

// Every enabled tool's schema is sent with every request, so this is the real
// token-cost ceiling on the feature — the per-guild server cap only bounds how
// many places those tools come from.
const MAX_TOOLS = 64;

// A tool result goes back to the model as a message, and a model with a 1k
// max_tokens reply budget cannot use a 200KB directory listing anyway.
const MAX_TOOL_RESULT_CHARS = 6000;

// How many times a model may call tools and be asked again before it has to
// answer. Each round is a full request, so this bounds both latency and spend.
const MAX_TOOL_ROUNDS = 4;

// OpenAI and Gemini both cap function names at 64 characters and allow only
// letters, digits, underscores and hyphens.
const MAX_NAME_LENGTH = 64;

// One entry per (url, token): the live client, the tool list and whatever the
// last failure was.
const entries = new Map();

function keyFor(connection) {
    return `${connection.url} ${connection.authorizationToken || ''}`;
}

function closeQuietly(client) {
    if (client) client.close().catch(() => {});
}

// Called on the way in rather than on a timer, so nothing keeps the process
// alive and an idle bot holds no sessions open.
function sweepIdleSessions(now) {
    for (const [key, entry] of entries) {
        if (now - entry.lastUsed < SESSION_IDLE_MS) continue;
        closeQuietly(entry.client);
        entries.delete(key);
    }
}

function entryFor(server) {
    const key = keyFor(server.connection);
    let entry = entries.get(key);
    if (!entry) {
        entry = { client: null, tools: null, toolsExpire: 0, error: null, errorExpire: 0, listing: null, lastUsed: 0 };
        entries.set(key, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
}

function clientFor(entry, server) {
    if (!entry.client) {
        entry.client = new McpHttpClient({
            url: server.connection.url,
            authorizationToken: server.connection.authorizationToken,
            label: server.name
        });
    }
    return entry.client;
}

/**
 * Run one request against a server, reconnecting once if the session went away.
 *
 * Servers expire sessions, and a bot that holds one across an idle hour will
 * meet that. The reconnect is the difference between "the tool call failed" and
 * nobody noticing.
 */
async function withSession(entry, server, fn) {
    try {
        return await fn(clientFor(entry, server));
    } catch (err) {
        if (!(err instanceof McpError) || !err.sessionExpired) throw err;
        closeQuietly(entry.client);
        entry.client = null;
        return fn(clientFor(entry, server));
    }
}

async function listTools(entry, server) {
    const now = Date.now();
    if (entry.tools && entry.toolsExpire > now) return entry.tools;
    if (entry.error && entry.errorExpire > now) throw entry.error;
    // A second message arriving mid-handshake waits for the first one's result
    // instead of opening a competing session.
    if (entry.listing) return entry.listing;

    entry.listing = withSession(entry, server, client => client.listTools())
        .then(tools => {
            entry.tools = tools;
            entry.toolsExpire = Date.now() + TOOL_LIST_TTL_MS;
            entry.error = null;
            entry.errorExpire = 0;
            return tools;
        })
        .catch(err => {
            entry.tools = null;
            entry.toolsExpire = 0;
            entry.error = err;
            entry.errorExpire = Date.now() + FAILURE_TTL_MS;
            closeQuietly(entry.client);
            entry.client = null;
            throw err;
        })
        .finally(() => { entry.listing = null; });

    return entry.listing;
}

// "github" + "search_repositories" has to survive as one function name the
// model can type back, within the character set both OpenAI and Gemini accept.
function qualifyName(serverName, toolName, used) {
    let base = `${serverName}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_');
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    base = base.slice(0, MAX_NAME_LENGTH);

    let candidate = base;
    for (let n = 2; used.has(candidate); n++) {
        const suffix = `_${n}`;
        candidate = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    }
    return candidate;
}

// Tools arrive with a JSON Schema, or with nothing when they take no arguments.
function schemaOf(tool) {
    const schema = tool.inputSchema || tool.input_schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }
    return schema;
}

/**
 * MCP content blocks as the one string a chat model can be handed back.
 *
 * Images and audio are dropped with a marker rather than base64'd into the
 * conversation: no provider here is guaranteed to accept them mid-tool-result,
 * and one screenshot would blow the context window on its own.
 */
function renderResult({ content, structuredContent, isError }) {
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block.type === 'resource' && typeof block.resource?.text === 'string') parts.push(block.resource.text);
        else if (block.type) parts.push(`[${block.type} content omitted]`);
    }
    if (!parts.length && structuredContent != null) {
        try {
            parts.push(JSON.stringify(structuredContent));
        } catch { /* circular or otherwise unserialisable — nothing to add */ }
    }

    let text = parts.join('\n').trim();
    if (!text) {
        text = isError
            ? 'The tool reported an error but sent no message.'
            : 'The tool returned no output.';
    }
    if (text.length > MAX_TOOL_RESULT_CHARS) {
        text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: the tool returned more than ${MAX_TOOL_RESULT_CHARS} characters]`;
    }
    return isError ? `The tool reported an error: ${text}` : text;
}

/**
 * Every tool the guild's MCP servers offer, in a shape any provider can use.
 *
 * Returns null when there is nothing to offer — no servers configured, none
 * reachable, or every tool filtered out — so a provider can take its plain path
 * unchanged. A server that fails is logged and skipped rather than failing the
 * reply: the rest of the answer is still worth sending.
 *
 * @param {Array} guildServers the guild's stored mcpServers documents
 * @returns {Promise<null|{definitions: Array, servers: string[], call: Function}>}
 */
async function prepareMcpToolkit(guildServers = []) {
    const servers = resolveMcpServers(guildServers);
    if (!servers.length) return null;

    sweepIdleSessions(Date.now());

    const definitions = [];
    const index = new Map();
    const used = new Set();
    const reached = [];

    for (const server of servers) {
        const entry = entryFor(server);
        let tools;
        try {
            tools = await listTools(entry, server);
        } catch (err) {
            console.warn(`[MCP] "${server.name}" is unavailable: ${err.message}`);
            continue;
        }
        reached.push(server.name);

        for (const tool of tools) {
            if (!isToolEnabled(server.toolset, tool.name)) continue;
            if (definitions.length >= MAX_TOOLS) {
                console.warn(`[MCP] more than ${MAX_TOOLS} tools are enabled — the rest are not being offered to the model`);
                break;
            }
            const name = qualifyName(server.name, tool.name, used);
            used.add(name);
            index.set(name, { server, entry, toolName: tool.name });
            definitions.push({
                name,
                serverName: server.name,
                toolName: tool.name,
                description: (tool.description || `${tool.name} on ${server.name}`).slice(0, 1024),
                inputSchema: schemaOf(tool)
            });
        }
        if (definitions.length >= MAX_TOOLS) break;
    }

    if (!definitions.length) return null;

    /**
     * Run one call the model asked for and return what to tell it.
     *
     * Never throws: a tool that 500s, times out or was hallucinated outright
     * comes back as text the model can read and route around, because the
     * alternative is losing a reply that was otherwise fine.
     */
    async function call(name, args) {
        const target = index.get(name);
        if (!target) return `No tool named "${name}" is available.`;

        try {
            const result = await withSession(target.entry, target.server, client =>
                client.callTool(target.toolName, args));
            return renderResult(result);
        } catch (err) {
            console.warn(`[MCP] "${target.server.name}" tool "${target.toolName}" failed: ${err.message}`);
            return `The tool could not be run: ${err.message}`;
        }
    }

    return { definitions, servers: reached, call };
}

/**
 * The toolkit for one provider request, or null when tools do not apply.
 *
 * `useMcp` is the caller's switch — commands that parse the reply as JSON pass
 * it false — and is checked here so no provider has to remember to.
 */
async function toolkitFor({ useMcp = true, mcpServers } = {}) {
    if (useMcp === false) return null;
    try {
        return await prepareMcpToolkit(mcpServers);
    } catch (err) {
        // Discovery is best-effort in every direction: an unreadable config or
        // a bad stored record must not cost the user their answer.
        console.warn(`[MCP] tool discovery failed: ${err.message}`);
        return null;
    }
}

// Only for tests, which must not inherit a session or a cached list from the
// case before them.
function resetMcpCache() {
    for (const entry of entries.values()) closeQuietly(entry.client);
    entries.clear();
}

module.exports = {
    prepareMcpToolkit,
    toolkitFor,
    renderResult,
    resetMcpCache,
    MAX_TOOL_ROUNDS,
    MAX_TOOLS,
    MAX_TOOL_RESULT_CHARS,
    TOOL_LIST_TTL_MS
};
