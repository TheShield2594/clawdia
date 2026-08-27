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

// How long past its TTL a list may still be served while a refresh runs behind
// it. Expiry is not a statement that the cached list is wrong — it is a
// reminder to go and check — so the message that happens to arrive on the
// wrong side of five minutes should not be the one that pays for the round
// trip. Past this the list is old enough that a caller waits for a fresh one.
const STALE_TTL_MS = 30 * 60 * 1000;

// How many requests one connection may have in flight at once.
//
// MAX_PARALLEL_TOOL_CALLS bounds a round globally, which is the wrong shape
// when every call in the round is aimed at the same place: six at once is a
// burst somebody else's server sees as one client misbehaving, and the servers
// most likely to be configured here are shared ones that rate-limit. Six calls
// spread across three servers still run three-wide each; six at one server
// queue.
const MAX_PARALLEL_PER_SERVER = 3;

// How long a caller may wait for one of those slots. The calls holding them
// are bounded — client.js enforces its deadline on the body as well as the
// headers now (#816) — so a wait this long means the queue is deep enough that
// the turn behind it is already lost, and refusing the call beats holding the
// reply open on a slot that may never come.
const SLOT_WAIT_TIMEOUT_MS = 60 * 1000;

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

// An OAuth connection's credential is not in the connection — it is a grant in
// the database that rotates — so the identity of the grant goes in the key
// instead (#796). Two guilds pointed at the same URL under different logins are
// two connections; the same guild's grant refreshing its access token is still
// one, which is the point of not keying on the token itself.
// Both halves are namespaced so neither can be spelled as the other: a static
// token that happened to read `oauth:g1/linear` would otherwise share a pooled
// connection, and therefore a session and a tool cache, with that guild's
// actual grant.
function keyFor(connection) {
    if (connection.oauth) {
        return `${connection.url} oauth:${connection.oauth.guildId}/${connection.oauth.server}`;
    }
    return `${connection.url} token:${connection.authorizationToken || ''}`;
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
        entry = { client: null, lists: new Map(), lastUsed: 0, inFlight: 0, waiters: [] };
        entries.set(key, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
}

/**
 * The client for one resolved server, wired to whichever credential it has.
 *
 * Shared with src/services/ai/mcp/inspect.js rather than written twice: the
 * dashboard's Test button has to dial exactly what a chat request would, and a
 * second copy of this wiring is how it stops doing that — the OAuth callback in
 * particular is easy to add in one place and forget in the other, which shows
 * up as a connection that works in a channel and 401s in the panel.
 */
function mcpClientFor(server) {
    const grant = server.connection.oauth;
    return new McpHttpClient({
        url: server.connection.url,
        authorizationToken: server.connection.authorizationToken,
        label: server.name,
        // Required lazily: the store reaches the Guild model, and this module is
        // loaded by the config layer the model's own schema sits under. A static
        // token connection never touches it.
        getAccessToken: grant
            ? ({ force }) => require('./oauthStore').accessTokenFor(grant.guildId, grant.server, { force })
            : null
    });
}

function clientFor(entry, server) {
    if (!entry.client) entry.client = mcpClientFor(server);
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

/**
 * At most MAX_PARALLEL_PER_SERVER of `fn` in flight against one connection.
 *
 * A finishing call hands its slot straight to the next waiter rather than
 * releasing it and letting the waiter take it back: between those two steps is
 * a microtask gap, and a caller arriving inside it would see a free slot that
 * is already spoken for.
 */
async function withServerLimit(entry, fn) {
    if (entry.inFlight >= MAX_PARALLEL_PER_SERVER) {
        await new Promise((resolve, reject) => {
            const waiter = { resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const index = entry.waiters.indexOf(waiter);
                // Already gone means a finishing call handed this waiter its
                // slot in the same tick; the resolution wins over the timeout.
                if (index < 0) return;
                entry.waiters.splice(index, 1);
                reject(new McpError('timed out waiting for a free connection slot on this server'));
            }, SLOT_WAIT_TIMEOUT_MS);
            waiter.timer.unref?.();
            entry.waiters.push(waiter);
        });
    } else {
        entry.inFlight++;
    }
    try {
        return await fn();
    } finally {
        const next = entry.waiters.shift();
        if (next) {
            clearTimeout(next.timer);
            next.resolve();
        } else {
            entry.inFlight--;
        }
    }
}

function slotFor(entry, kind) {
    let slot = entry.lists.get(kind);
    if (!slot) {
        slot = { value: null, expires: 0, staleUntil: 0, error: null, errorExpire: 0, pending: null };
        entry.lists.set(kind, slot);
    }
    return slot;
}

/** Record a list somebody else already fetched, as though this pool had. */
function primeList(entry, kind, value) {
    if (!value) return;
    const slot = slotFor(entry, kind);
    slot.value = value;
    slot.expires = Date.now() + LIST_TTL_MS;
    slot.staleUntil = slot.expires + STALE_TTL_MS;
    slot.error = null;
    slot.errorExpire = 0;
}

// The refresh half of cachedList: one request, its result written back to the
// slot. Errors are recorded and rethrown; whether anybody is waiting on the
// rejection is the caller's business.
//
// Through the same per-server gate as everything else: a list refresh is a
// request that server has to answer, so three tool calls in flight and a
// refresh starting behind them would be a fourth. Safe to queue precisely
// because nothing nests inside it — and the caller it delays is usually
// nobody, since an expired list is served stale while this runs.
function refreshList(entry, server, kind, fn) {
    const slot = slotFor(entry, kind);

    slot.pending = withServerLimit(entry, () => withSession(entry, server, fn))
        .then(value => {
            slot.value = value;
            slot.expires = Date.now() + LIST_TTL_MS;
            slot.staleUntil = slot.expires + STALE_TTL_MS;
            slot.error = null;
            slot.errorExpire = 0;
            return value;
        })
        .catch(err => {
            // `value` is deliberately left alone: a refresh that failed has not
            // shown the old list to be wrong, and serving it for a little
            // longer beats telling a guild its server has no tools because one
            // request timed out. `expires` is already past, so the next caller
            // still tries to refresh.
            slot.error = err;
            slot.errorExpire = Date.now() + FAILURE_TTL_MS;
            // The client stays. One list refused is not a broken session, and
            // dropping the shared client here would close a session another
            // caller is mid-tool-call on — three callers share this one now.
            // withSession already replaces a client whose session really did
            // expire, which is the only case that needs a new one.
            if (err instanceof McpError && err.sessionExpired) {
                closeQuietly(entry.client);
                entry.client = null;
            }
            throw err;
        })
        .finally(() => { slot.pending = null; });

    return slot.pending;
}

/**
 * One of a server's lists — tools, resources, prompts — cached per kind.
 *
 * A failure is cached alongside the value, so a server that is down is not
 * dialled again on every message. Per kind rather than per connection: a
 * server can refuse resources/list and answer tools/list perfectly well, and
 * one refused list should not take the tool loop down with it for a minute.
 *
 * Expiry starts a refresh; it does not block on one. A list that has aged past
 * its TTL is still almost certainly right — servers gain a tool about never —
 * so the caller that happens to arrive first gets the old list and the new one
 * lands behind it, which is the difference between one message in every five
 * minutes paying a round trip and none of them doing.
 */
async function cachedList(entry, server, kind, fn) {
    const now = Date.now();
    const slot = slotFor(entry, kind);

    if (slot.value && slot.expires > now) return slot.value;

    const stale = slot.value && slot.staleUntil > now ? slot.value : null;
    // A second message arriving mid-handshake waits for the first one's result
    // instead of opening a competing session.
    const inFlight = slot.pending
        || (slot.error && slot.errorExpire > now ? null : refreshList(entry, server, kind, fn));

    if (stale) {
        // Nobody is awaiting this one, so its rejection needs a home.
        if (inFlight) inFlight.catch(() => {});
        return stale;
    }
    if (!inFlight) throw slot.error;
    return inFlight;
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
    mcpClientFor,
    withSession,
    withServerLimit,
    cachedList,
    primeList,
    closeQuietly,
    sweepIdleSessions,
    resetMcpCache,
    mapWithLimit,
    LIST_TTL_MS,
    STALE_TTL_MS,
    FAILURE_TTL_MS,
    SESSION_IDLE_MS,
    MAX_PARALLEL_PER_SERVER,
    SLOT_WAIT_TIMEOUT_MS
};
