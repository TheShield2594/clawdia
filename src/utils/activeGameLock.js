/**
 * In-memory per-user action locks.
 *
 * Prevents a user from running two instances of the same action concurrently
 * (e.g. two /casino games, or two /fish casts racing the same user document).
 * Locks are process-local — sufficient for a single-process bot — and carry a
 * TTL backstop so a crashed flow can never deadlock a user permanently.
 */

const locks = new Map(); // key -> expiry timestamp (ms)

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Attempts to acquire the lock for `key`. Returns true on success, false if
 * the key is already locked (and not yet expired).
 */
function tryAcquire(key, ttlMs = DEFAULT_TTL_MS) {
    const now    = Date.now();
    const expiry = locks.get(key);
    if (expiry && expiry > now) return false;
    locks.set(key, now + ttlMs);
    return true;
}

/** Releases the lock for `key` (no-op if not held). */
function release(key) {
    locks.delete(key);
}

// Periodically sweep expired entries so the map doesn't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [key, expiry] of locks) {
        if (expiry <= now) locks.delete(key);
    }
}, 60_000).unref();

module.exports = { tryAcquire, release };
