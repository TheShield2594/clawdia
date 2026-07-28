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
