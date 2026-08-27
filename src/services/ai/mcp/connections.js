'use strict';

const { McpHttpClient, McpError } = require('./client');

/**
 * One pool of MCP connections, shared by everything that talks to a server.
 *
 * There are three callers now — the tool loop, the resources the knowledge
 * prompt is built from, and the prompt templates behind `/ai mcp prompt` — and
 * a Discord conversation is many requests against the same handful of servers.
 * Each of those callers opening its own client would mean a second handshake, a
 * second session for the far side to hold, and two caches disagreeing about
 * whether a server is up.
 *
 * So the client, the session and every cached list live here, keyed by
 * (url, token). A caller asks for an entry, asks for a list by kind, and gets
 * whatever the pool already knows.
 */

// Lists are stable in practice; five minutes picks up a server that gained a
// tool or a resource without asking it on every message.
const LIST_TTL_MS = 5 * 60 * 1000;

// A server that is down should not be dialled again on every single message,
// but it should recover on its own within a conversation.
const FAILURE_TTL_MS = 60 * 1000;

// Sessions cost the server memory. An idle one is closed rather than held open
// for a guild that used a tool once this afternoon.
const SESSION_IDLE_MS = 10 * 60 * 1000;

// One entry per (url, token): the live client and one cache slot per kind of
// list somebody has asked for.
const entries = new Map();

/**
 * `items.map(fn)` run concurrently, at most `limit` at a time, results in order.
 *
 * Every fan-out here is a set of independent network waits that would otherwise
 * be spent one after another — the servers being listed, the calls in one tool
 * round, the resources being read for one message. `fn` is expected not to
 * throw; callers catch their own failures and return them as values, because a
 * rejection would abandon the results of everything else in flight.
 */
async function mapWithLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;

    const worker = async () => {
        for (let i = next++; i < items.length; i = next++) {
            results[i] = await fn(items[i], i);
        }
    };

    const workers = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}

function keyFor(connection) {
    return `${connection.url} ${connection.authorizationToken || ''}`;
}

function closeQuietly(client) {
    if (client) client.close().catch(() => {});
}

// Called on the way in rather than on a timer, so nothing keeps the process
// alive and an idle bot holds no sessions open.
function sweepIdleSessions(now = Date.now()) {
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
        entry = { client: null, lists: new Map(), lastUsed: 0 };
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

function slotFor(entry, kind) {
    let slot = entry.lists.get(kind);
    if (!slot) {
        slot = { value: null, expires: 0, error: null, errorExpire: 0, pending: null };
        entry.lists.set(kind, slot);
    }
    return slot;
}

/**
 * One of a server's lists — tools, resources, prompts — cached per kind.
 *
 * A failure is cached alongside the value, so a server that is down is not
 * dialled again on every message. Per kind rather than per connection: a
 * server can refuse resources/list and answer tools/list perfectly well, and
 * one refused list should not take the tool loop down with it for a minute.
 */
async function cachedList(entry, server, kind, fn) {
    const now = Date.now();
    const slot = slotFor(entry, kind);

    if (slot.value && slot.expires > now) return slot.value;
    if (slot.error && slot.errorExpire > now) throw slot.error;
    // A second message arriving mid-handshake waits for the first one's result
    // instead of opening a competing session.
    if (slot.pending) return slot.pending;

    slot.pending = withSession(entry, server, fn)
        .then(value => {
            slot.value = value;
            slot.expires = Date.now() + LIST_TTL_MS;
            slot.error = null;
            slot.errorExpire = 0;
            return value;
        })
        .catch(err => {
            slot.value = null;
            slot.expires = 0;
            slot.error = err;
            slot.errorExpire = Date.now() + FAILURE_TTL_MS;
            closeQuietly(entry.client);
            entry.client = null;
            throw err;
        })
        .finally(() => { slot.pending = null; });

    return slot.pending;
}

// Only for tests, which must not inherit a session or a cached list from the
// case before them.
function resetMcpCache() {
    for (const entry of entries.values()) closeQuietly(entry.client);
    entries.clear();
}

module.exports = {
    entryFor,
    clientFor,
    withSession,
    cachedList,
    closeQuietly,
    sweepIdleSessions,
    resetMcpCache,
    mapWithLimit,
    LIST_TTL_MS,
    FAILURE_TTL_MS,
    SESSION_IDLE_MS
};
