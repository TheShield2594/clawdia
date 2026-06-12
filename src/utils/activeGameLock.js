/**
 * In-memory per-user action locks.
 *
 * Prevents a user from running two instances of the same action concurrently
 * (e.g. two /casino games, or two /fish casts racing the same user document).
 * Locks are process-local — sufficient for a single-process bot — and carry a
 * TTL backstop so a crashed flow can never deadlock a user permanently.
 *
 * Acquisition returns a lease token; release requires the matching token, so
 * a holder whose lease expired (and whose key was re-acquired by a newer flow)
 * cannot release the new holder's lock.
 */

const locks = new Map(); // key -> { expiry, token }

const DEFAULT_TTL_MS = 10 * 60 * 1000;

let tokenCounter = 0;

/**
 * Attempts to acquire the lock for `key`. Returns a lease token (truthy) on
 * success, or null if the key is already locked (and not yet expired).
 */
function tryAcquire(key, ttlMs = DEFAULT_TTL_MS) {
    const now      = Date.now();
    const existing = locks.get(key);
    if (existing && existing.expiry > now) return null;
    const token = `${now}-${++tokenCounter}`;
    locks.set(key, { expiry: now + ttlMs, token });
    return token;
}

/**
 * Releases the lock for `key` if `token` matches the current lease.
 * Returns true if the lock was released, false otherwise (wrong token,
 * already released, or re-acquired by another flow after expiry).
 */
function release(key, token) {
    const existing = locks.get(key);
    if (!existing || existing.token !== token) return false;
    locks.delete(key);
    return true;
}

// Periodically sweep expired entries so the map doesn't grow unbounded.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of locks) {
        if (entry.expiry <= now) locks.delete(key);
    }
}, 60_000).unref();

module.exports = { tryAcquire, release };
