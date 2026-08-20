/**
 * Per-user action locks, held in Mongo.
 *
 * Stops a user running two instances of the same money-moving action at once —
 * two /casino games, or two /fish casts racing the same user document. This is
 * a boundary, not a convenience: everything it guards ends in a coin write, so
 * a lock that only holds within one process is a lock that stops holding the
 * moment a second process exists. It used to be a `Map`, which meant a restart
 * dropped every lease and a second instance shared none of them — and since
 * there is no sharding scaffolding anywhere in `src/`, a second instance would
 * have double-paid users rather than scaled them.
 *
 * Acquisition is a single conditional upsert, which is what makes it safe
 * across processes:
 *
 *   - No document for the key      → the upsert inserts one. Acquired.
 *   - A document past `expiresAt`  → the filter matches and the update takes it
 *                                    over with a fresh token. Acquired.
 *   - A document still live        → the filter misses, the upsert tries to
 *                                    insert, and the unique index on `key`
 *                                    rejects it. Held by someone else.
 *
 * Expiry is decided by comparing `expiresAt` at acquire time rather than by the
 * TTL index, whose sweep is far too coarse to gate a lease on. The TTL index
 * only reclaims documents nobody came back for.
 *
 * Acquisition returns a lease token; release requires the matching token, so a
 * holder whose lease expired — and whose key was then taken by a newer flow —
 * cannot release the new holder's lock.
 *
 * An acquire also records what the lease is being held *for*. One key now
 * covers every money-moving command a user can run (see utils/economyLock.js),
 * so "you already have something in progress" is only useful if it can say
 * which something — `holderActivity` is how the turned-away call finds out.
 */

const ActiveLock = require('../models/ActiveLock');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

let tokenCounter = 0;

// A lease token has to be unique across processes, not just within one, or a
// restarted process could mint a token that frees a lock it no longer owns.
function mintToken(now) {
    return `${process.pid}-${now}-${++tokenCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// The unique index on `key` rejecting the insert IS the "already held" signal,
// so this is a normal outcome rather than a failure.
function isDuplicateKey(err) {
    return err?.code === 11000 || err?.code === 11001 || err?.codeName === 'DuplicateKey';
}

/**
 * Attempts to acquire the lock for `key`. Returns a lease token (truthy) on
 * success, or null if the key is already locked and not yet expired.
 *
 * A database error also returns null — refusing the action is the safe answer
 * for something that gates money, and if Mongo is unreachable the action it
 * guards has nothing to write to anyway.
 */
async function tryAcquire(key, ttlMs = DEFAULT_TTL_MS, activity = null) {
    const now   = Date.now();
    const token = mintToken(now);

    try {
        const lock = await ActiveLock.findOneAndUpdate(
            { key, expiresAt: { $lte: new Date(now) } },
            { $set: { key, token, expiresAt: new Date(now + ttlMs), activity } },
            { new: true, upsert: true },
        );
        // Someone else's token coming back would mean a concurrent takeover won.
        return lock?.token === token ? token : null;
    } catch (err) {
        if (isDuplicateKey(err)) return null;
        console.error('[activeGameLock] acquire failed:', err);
        return null;
    }
}

/**
 * What the live lease on `key` is being held for, or null if nothing holds it,
 * the holder recorded no activity, or the read failed.
 *
 * Only ever used to word a message, so every failure answers null and lets the
 * caller fall back to generic phrasing — never to decide whether a lock is held,
 * which is `tryAcquire`'s job and has to stay a single atomic operation.
 */
async function holderActivity(key) {
    try {
        const lock = await ActiveLock.findOne({ key }).lean();
        if (!lock || lock.expiresAt <= new Date()) return null;
        return lock.activity ?? null;
    } catch (err) {
        console.error('[activeGameLock] holder lookup failed:', err);
        return null;
    }
}

/**
 * Releases the lock for `key` if `token` matches the current lease.
 * Returns true if the lock was released, false otherwise (wrong token,
 * already released, or re-acquired by another flow after expiry).
 */
async function release(key, token) {
    if (!token) return false;
    try {
        const { deletedCount } = await ActiveLock.deleteOne({ key, token });
        return deletedCount === 1;
    } catch (err) {
        // Leaving it to expire is the safe failure: the TTL frees the key, and
        // the worst case is one user blocked from a second game until then.
        console.error('[activeGameLock] release failed:', err);
        return false;
    }
}

module.exports = { tryAcquire, holderActivity, release, DEFAULT_TTL_MS };
