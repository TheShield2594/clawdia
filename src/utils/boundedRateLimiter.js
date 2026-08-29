'use strict';

/**
 * Sliding-window rate limiter with a hard cap on how many keys it will track.
 *
 * The cap is the point of the class. A plain `Map` keyed by user or channel ID
 * grows for every distinct key it ever sees, and a periodic sweep only reclaims
 * entries *after* they expire — so a burst of unique keys (or simply a large
 * server) inflates it faster than the sweep can drain it. Bounding the map
 * turns unbounded growth into a fixed ceiling.
 *
 * Eviction is FIFO by insertion order, which `Map` preserves: when the map is
 * full the oldest key is dropped to make room. Dropping a key only forgives
 * whatever requests it had recorded, so the failure mode under key-flooding is
 * a briefly more permissive limit rather than unbounded memory.
 */
class BoundedRateLimiter {
    constructor(maxSize = 10_000) {
        this._map = new Map();
        this._maxSize = maxSize;
    }

    /**
     * Records a request against `key` and reports whether it is allowed.
     * Returns false when `key` already has `limit` requests inside `windowMs`,
     * in which case nothing is recorded.
     */
    check(key, windowMs, limit) {
        const now = Date.now();
        const arr = (this._map.get(key) || []).filter(t => now - t < windowMs);
        if (arr.length >= limit) {
            this._map.set(key, arr); // refresh pruned array
            return false;
        }
        // Evict the oldest key before inserting a new one.
        if (!this._map.has(key) && this._map.size >= this._maxSize) {
            this._map.delete(this._map.keys().next().value);
        }
        arr.push(now);
        this._map.set(key, arr);
        return true;
    }

    /**
     * Reports whether `key` would be allowed right now, without recording it.
     *
     * This exists so a caller can refuse early — before doing the database and
     * network work a request needs — while the one call that actually spends
     * the budget stays the only thing that consumes a slot. A peek that passes
     * is not a reservation: another request can take the last slot before the
     * consuming `check` runs, which is exactly the outcome the limit is for.
     */
    peek(key, windowMs, limit) {
        const now = Date.now();
        const arr = this._map.get(key);
        if (!arr) return true;
        return arr.filter(t => now - t < windowMs).length < limit;
    }

    /**
     * Records a hit against `key` and returns how many hits fall inside
     * `windowMs`, counting the one just recorded.
     *
     * `check` above answers "may this happen?" and refuses to record once the
     * limit is reached. Some callers want the opposite reading: the event is
     * real and has already happened, and the count itself is the signal — spam
     * detection fires *because* the fifth message in five seconds exists. Those
     * callers get the count and decide, rather than being handed a boolean that
     * has already made the decision with an off-by-one to unpick.
     *
     * Eviction is the same FIFO rule `check` uses, so a caller mixing the two
     * on one instance sees one bounded map rather than two policies.
     */
    hit(key, windowMs) {
        const now = Date.now();
        const timestamps = (this._map.get(key) || []).filter(t => now - t < windowMs);
        if (!this._map.has(key) && this._map.size >= this._maxSize) {
            this._map.delete(this._map.keys().next().value);
        }
        timestamps.push(now);
        this._map.set(key, timestamps);
        return timestamps.length;
    }

    /**
     * Forgets `key` entirely, so its next hit counts as the first.
     *
     * This is what a caller that *acted* on a count needs: having punished the
     * spammer, the window that proved it must not also prove the next message,
     * or one burst becomes a punishment per message until it ages out.
     */
    reset(key) {
        this._map.delete(key);
    }

    /** Drops keys whose recorded requests have all aged out of `windowMs`. */
    cleanup(windowMs) {
        const cutoff = Date.now() - windowMs;
        for (const [key, timestamps] of this._map) {
            if (timestamps.every(t => t < cutoff)) this._map.delete(key);
        }
    }

    /** Number of keys currently tracked. Exposed for tests and diagnostics. */
    get size() {
        return this._map.size;
    }
}

module.exports = { BoundedRateLimiter };
