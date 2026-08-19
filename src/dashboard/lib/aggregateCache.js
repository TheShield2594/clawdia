'use strict';

/**
 * Short-TTL memo for the dashboard's collection-wide aggregations.
 *
 * The analytics panels are built from queries that touch every user in a guild:
 * the net-worth leaderboard sorts on a computed field, so no index can serve the
 * ordering, and the coin/message totals are `$group`s with nothing to narrow
 * them. Each of those is affordable once. What made them expensive is that
 * nothing stopped them running again on the very next request — opening two
 * panels, or leaving a tab refreshing, re-ran the same scan against unchanged
 * data.
 *
 * A denormalised column would remove the scan outright, and for net worth that
 * was considered and rejected: keeping it in step would fall on all 41 files
 * that move coins, and one missed `$inc` rots the ranking silently (see
 * src/utils/netWorth.js). Caching costs a bounded amount of staleness instead,
 * and the numbers involved — total coins in circulation, this week's top ten —
 * do not become wrong in thirty seconds.
 *
 * Concurrent callers on a cold key share one query rather than each starting
 * their own. That matters more than the hit rate: without it, N simultaneous
 * requests are N simultaneous full scans, which is precisely the shape of the
 * read-flood the rate limiter also guards against.
 */

const DEFAULT_TTL_MS = 30_000;

// The map is keyed by guild, so it grows with the number of guilds an operator's
// admins actually visit. The cap turns that into a ceiling anyway; eviction is
// FIFO by insertion order, which `Map` preserves.
const MAX_ENTRIES = 1_000;

const entries = new Map();

/**
 * Returns the memoised result of `fn`, running it only when no fresh value is
 * cached and no identical call is already in flight.
 *
 * A rejected call is not cached — the next caller retries rather than being
 * handed the failure for the rest of the TTL.
 */
async function cachedAggregate(key, fn, ttlMs = DEFAULT_TTL_MS) {
    const now = Date.now();
    const hit = entries.get(key);

    if (hit) {
        if (hit.pending) return hit.pending;
        if (hit.expiresAt > now) return hit.value;
        entries.delete(key);
    }

    const pending = (async () => {
        const value = await fn();
        // Only replace the placeholder if it is still ours: an `invalidate` during
        // the query means the caller knows the data moved, and this result predates
        // that knowledge.
        if (entries.get(key)?.pending === pending) {
            entries.set(key, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
    })();

    pending.catch(() => {
        if (entries.get(key)?.pending === pending) entries.delete(key);
    });

    if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
    entries.set(key, { pending });

    return pending;
}

/** Drops one key, for callers that have just made its value wrong. */
function invalidate(key) {
    entries.delete(key);
}

/**
 * Drops every key whose prefix matches. Keys are `<guildId>:<name>` precisely so
 * one guild's entries can be dropped without touching another's.
 */
function invalidatePrefix(prefix) {
    for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key);
    }
}

/** Exposed for tests. */
function __reset() {
    entries.clear();
}

module.exports = { cachedAggregate, invalidate, invalidatePrefix, DEFAULT_TTL_MS, __reset };
