const { Schema, model } = require('mongoose');

/**
 * A held per-user action lock.
 *
 * One document per lock key, existing only while the lock is held. See
 * src/utils/activeGameLock.js for how the acquire and release are made atomic —
 * the unique index on `key` is what does the work there, so it is not optional.
 */
const activeLockSchema = new Schema({
    key:       { type: String, required: true, unique: true },
    token:     { type: String, required: true },
    expiresAt: { type: Date,   required: true },
});

// A garbage collector, not the expiry mechanism: Mongo's TTL monitor only runs
// about once a minute, which is far too coarse to decide whether a lock is
// still held. Acquisition compares `expiresAt` itself and takes over an expired
// lock immediately; this index just stops abandoned documents accumulating.
activeLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('ActiveLock', activeLockSchema);
