'use strict';

/**
 * Where an MCP OAuth grant lives, and who is allowed to refresh it (#796).
 *
 * `oauth.js` is the protocol with no storage in it; this is the storage, with
 * as little protocol as possible. It exists because three things need the same
 * grant and must not each have their own idea of it: the MCP client (which
 * needs a valid access token for every request), the dashboard callback (which
 * writes the first one), and the connection cache (which has to notice when a
 * token changed underneath it).
 *
 * ── The rotation problem ───────────────────────────────────────────────────
 * A refresh token that rotates is single-use: the server issues a new one and
 * invalidates the old one, so two concurrent refreshes on the same grant means
 * the second presents a token the first has already spent, and the whole grant
 * is revoked — the admin has to reconnect by hand. Discord traffic makes that
 * easy to hit: three messages in a guild at once, all finding the same expired
 * access token.
 *
 * So a refresh is serialised per grant. In-process, which is the honest scope
 * of it: a sharded deployment can still race two processes, and the guard for
 * that is the conditional write below — the refresh is stored with a filter on
 * the refresh token it was made with, so a second process's refresh cannot
 * overwrite a newer grant with an older one. What it cannot prevent is the
 * server revoking a rotated token, which is why the store re-reads and reuses a
 * grant another writer refreshed rather than refreshing again.
 *
 * ── Why the config file cannot hold one ────────────────────────────────────
 * `${ENV_VAR}` expansion is how the operator config file holds secrets, and it
 * is read-only: a refresh token that rotates would have to be written back into
 * the operator's environment, which is not something a process can do. So OAuth
 * is a dashboard-managed connection only, and a config-file server keeps the
 * static token it always had.
 */

const Guild = require('../../../models/Guild');
const { encryptSecret, decryptSecret } = require('../../../config/secretBox');
const { refreshTokens, needsRefresh, OAuthError, REFRESH_SKEW_MS } = require('./oauth');

// One in-flight refresh per grant, keyed by guild and server name. Concurrent
// callers await the same promise rather than each spending the refresh token.
const inFlight = new Map();

const keyOf = (guildId, server) => `${guildId} ${server}`;

/**
 * The live access token per grant, so a request that needs one does not read
 * Mongo to be told what it was told a second ago (#838).
 *
 * `accessTokenFor` is asked before *every* MCP request — the client re-asks
 * rather than caching, because a pooled connection sits idle while its token
 * expires — and a turn that runs six tool calls across two servers was six
 * `findOne`s deep before a single byte went out. The token itself is what
 * changes on a clock the process already knows about, so it is the thing worth
 * holding.
 *
 * Held only while it is unambiguously live: `MEMO_SKEW_MS` short of the grant's
 * own expiry, so a memo never outlives the refresh it should have triggered.
 * A grant with no expiry is not memoized at all — a token of unknown lifetime
 * is one the database is entitled to have changed.
 *
 * Dropped on every write to the grant (`saveGrant`, `clearGrant`, a refresh)
 * and on the forced path, which is what a 401 takes: the server has just said
 * the memoized token is no good, and re-offering it would spend the retry on
 * the same credential. This is per process and deliberately so — another shard
 * refreshing early is a token this one has not seen, which costs it one 401 and
 * the forced refresh that already handles exactly that.
 */
const tokenMemo = new Map();

// How far ahead of the grant's expiry the memo is dropped. Derived from the
// refresh margin rather than written out again, and twice it, so the memo is
// always the first of the two to lapse: a memo that outlived `needsRefresh`
// would hand back a token in the window the store had already decided to
// refresh, which is the one thing it must not do.
const MEMO_SKEW_MS = REFRESH_SKEW_MS * 2;

// `expiresAt` reaches here as whatever Mongo gave back — a Date, or the string
// a `.lean()` read of a fresh write can carry — so it is normalised rather
// than assumed. Anything unparseable is treated as no expiry at all, which
// means no memo.
function expiryMs(expiresAt) {
    if (!expiresAt) return null;
    const at = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
    return Number.isFinite(at) ? at : null;
}

function memoGet(key) {
    const entry = tokenMemo.get(key);
    if (!entry) return null;
    if (entry.until <= Date.now()) {
        tokenMemo.delete(key);
        return null;
    }
    return entry.token;
}

function memoSet(key, token, expiresAt) {
    const at = expiryMs(expiresAt);
    if (!token || at === null) return;
    const until = at - MEMO_SKEW_MS;
    if (until <= Date.now()) return;
    tokenMemo.set(key, { token, until });
}

/** The stored grant with its secrets decrypted, or null. */
function openGrant(stored) {
    if (!stored || typeof stored !== 'object') return null;
    return {
        guildId:               stored.guildId,
        issuer:                stored.issuer,
        authorizationEndpoint: stored.authorizationEndpoint,
        tokenEndpoint:         stored.tokenEndpoint,
        resource:              stored.resource ?? null,
        clientId:              stored.clientId,
        clientSecret:          stored.clientSecret ? decryptSecret(stored.clientSecret) : null,
        accessToken:           stored.accessToken ? decryptSecret(stored.accessToken) : null,
        refreshToken:          stored.refreshToken ? decryptSecret(stored.refreshToken) : null,
        expiresAt:             stored.expiresAt ?? null,
        scope:                 stored.scope ?? null,
        // Carried through even though nothing here reads them: `refreshGrant`
        // spreads this object into the one it hands `sealGrant`, so a field
        // dropped here is a field a refresh quietly overwrites — who connected
        // the grant would be lost, and when, reset to the moment of the first
        // token renewal.
        connectedBy:           stored.connectedBy ?? null,
        connectedAt:           stored.connectedAt ?? null,
    };
}

/** The three secret fields encrypted, for storage. */
function sealGrant(grant) {
    return {
        guildId:               grant.guildId,
        issuer:                grant.issuer,
        authorizationEndpoint: grant.authorizationEndpoint,
        tokenEndpoint:         grant.tokenEndpoint,
        resource:              grant.resource ?? null,
        clientId:              grant.clientId,
        clientSecret:          grant.clientSecret ? encryptSecret(grant.clientSecret) : null,
        accessToken:           grant.accessToken ? encryptSecret(grant.accessToken) : null,
        refreshToken:          grant.refreshToken ? encryptSecret(grant.refreshToken) : null,
        expiresAt:             grant.expiresAt ?? null,
        scope:                 grant.scope ?? null,
        connectedBy:           grant.connectedBy ?? null,
        connectedAt:           grant.connectedAt ?? new Date(),
    };
}

/** Reads one guild server's grant straight from the database. */
async function readGrant(guildId, server) {
    const doc = await Guild.findOne(
        { guildId, 'ai.mcpServers.name': server },
        { 'ai.mcpServers.$': 1 },
    ).lean();
    return openGrant(doc?.ai?.mcpServers?.[0]?.oauth);
}

/** Writes a grant, replacing whatever was there. Used by the dashboard callback. */
async function saveGrant(guildId, server, grant) {
    tokenMemo.delete(keyOf(guildId, server));
    const result = await Guild.updateOne(
        { guildId, 'ai.mcpServers.name': server },
        {
            $set: {
                'ai.mcpServers.$.oauth': sealGrant({ ...grant, guildId }),
                // A connection authorizes one way or the other. Leaving a stale
                // static token behind would make "which credential is this
                // using" unanswerable from the record.
                'ai.mcpServers.$.authorizationToken': null,
            },
        },
    );
    return (result.matchedCount ?? result.n ?? 0) > 0;
}

/** Drops a grant, so the connection goes back to being unauthenticated. */
async function clearGrant(guildId, server) {
    inFlight.delete(keyOf(guildId, server));
    tokenMemo.delete(keyOf(guildId, server));
    const result = await Guild.updateOne(
        { guildId, 'ai.mcpServers.name': server },
        { $set: { 'ai.mcpServers.$.oauth': null } },
    );
    return (result.matchedCount ?? result.n ?? 0) > 0;
}

/**
 * Stores a refreshed grant, but only if nobody else refreshed it first.
 *
 * The filter names the refresh token this refresh was made with, so in a
 * sharded deployment a second process that refreshed a moment earlier is not
 * overwritten by this one's older result. A miss is not an error — it means
 * somebody else's newer grant is in place, and the caller re-reads and uses it.
 */
async function storeRefreshed(guildId, server, previousRefreshToken, grant) {
    const result = await Guild.updateOne(
        {
            guildId,
            'ai.mcpServers': {
                $elemMatch: { name: server, 'oauth.refreshToken': previousRefreshToken },
            },
        },
        { $set: { 'ai.mcpServers.$.oauth': sealGrant(grant) } },
    );
    return (result.modifiedCount ?? result.nModified ?? 0) > 0;
}

/**
 * Refreshes one grant, once, however many callers ask at the same time.
 *
 * Returns the grant to use. On a lost race it is the *other* writer's grant,
 * re-read from the database rather than refreshed again — presenting a rotated
 * refresh token a second time is what gets the whole grant revoked.
 */
async function refreshGrant(guildId, server, grant, { encryptedRefreshToken }) {
    const key = keyOf(guildId, server);
    const existing = inFlight.get(key);
    if (existing) return existing;

    tokenMemo.delete(key);

    const attempt = (async () => {
        const fresh = await refreshTokens(grant.tokenEndpoint, {
            refreshToken: grant.refreshToken,
            clientId: grant.clientId,
            clientSecret: grant.clientSecret,
            resource: grant.resource,
        });

        const updated = {
            ...grant,
            accessToken: fresh.accessToken,
            // A server that does not rotate omits the refresh token; keeping
            // the one already held is the difference between a grant that
            // survives and one that has to be reconnected by hand.
            refreshToken: fresh.refreshToken ?? grant.refreshToken,
            expiresAt: fresh.expiresAt,
            scope: fresh.scope ?? grant.scope,
        };

        const stored = await storeRefreshed(guildId, server, encryptedRefreshToken, updated);
        if (stored) {
            memoSet(key, updated.accessToken, updated.expiresAt);
            return updated;
        }

        // Somebody else got there first. Theirs is newer than this one by
        // definition, so it is the one to use.
        const other = await readGrant(guildId, server);
        const winner = other?.accessToken ? other : updated;
        memoSet(key, winner.accessToken, winner.expiresAt);
        return winner;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, attempt);
    return attempt;
}

/**
 * An access token for one guild server, refreshed if it is due.
 *
 * `force` is the 401 path: the server rejected a token this thought was still
 * valid, which happens whenever a grant is revoked, a scope changes, or the
 * server simply expires tokens early. One forced refresh and one retry is the
 * whole recovery — a second 401 after a fresh token is the server saying no,
 * not a clock problem.
 *
 * Returns null when there is no grant. A refresh that fails falls back to the
 * token already held rather than to nothing: the server is the judge of whether
 * it still works, and the request then fails with the server's own message the
 * way it did before any of this existed.
 */
async function accessTokenFor(guildId, server, { force = false } = {}) {
    if (!guildId || !server) return null;

    const key = keyOf(guildId, server);
    if (force) {
        // The caller is here because the server rejected what it was last
        // given, which may well be what is memoized.
        tokenMemo.delete(key);
    } else {
        const memoized = memoGet(key);
        if (memoized) return memoized;
    }

    const doc = await Guild.findOne(
        { guildId, 'ai.mcpServers.name': server },
        { 'ai.mcpServers.$': 1 },
    ).lean();

    const stored = doc?.ai?.mcpServers?.[0]?.oauth;
    const grant = openGrant(stored);
    if (!grant?.accessToken && !grant?.refreshToken) return null;

    if (!force && grant.accessToken && !needsRefresh(grant.expiresAt)) {
        memoSet(key, grant.accessToken, grant.expiresAt);
        return grant.accessToken;
    }
    if (!grant.refreshToken) {
        // Nothing to refresh with. The access token is all there is, so it is
        // offered even when it looks expired — the server is the judge.
        return grant.accessToken;
    }

    try {
        const refreshed = await refreshGrant(guildId, server, grant, {
            encryptedRefreshToken: stored.refreshToken,
        });
        return refreshed.accessToken;
    } catch (err) {
        // A refresh that is refused rather than merely failing means the grant
        // is gone — revoked, or a rotated token spent twice — and no amount of
        // retrying brings it back. It is left in place regardless: deleting it
        // would lose the issuer and client id an admin's reconnect starts from.
        const refused = err instanceof OAuthError && err.status >= 400 && err.status < 500;
        console.warn(
            `[MCP] could not refresh the OAuth grant for "${server}" in ${guildId}`
            + `${refused ? ' — it has been revoked or expired, an admin must reconnect it' : ''}: ${err.message}`,
        );
        return grant.accessToken;
    }
}

/** Test seam: drops the in-flight refresh map. */
function _resetOAuthStore() {
    inFlight.clear();
    tokenMemo.clear();
}

module.exports = {
    readGrant, saveGrant, clearGrant, accessTokenFor,
    openGrant, sealGrant, _resetOAuthStore, MEMO_SKEW_MS,
};
