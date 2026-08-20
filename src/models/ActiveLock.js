const { Schema, model } = require('mongoose');

/**
 * A held per-user action lock.
 *
 * One document per lock key, existing only while the lock is held. See
 * src/utils/activeGameLock.js for how the acquire and release are made atomic —
 * the unique index on `key` is what does the work there, so it is not optional.
 */
const activeLockSchema = new Schema({
    // `unique` here declares the intent; migration 012 is what guarantees it.
    // Mongoose's own index build is asynchronous and unordered against the first
    // query, which is too weak for an index the lock's correctness rests on.
    key:       { type: String, required: true, unique: true },
    token:     { type: String, required: true },
    expiresAt: { type: Date,   required: true },
    // What the lease is being held for ('hunt', 'casino', …), so a user turned
    // away from one economy command can be told which other one is holding
    // them up. Optional: a lock with no activity still locks, it just gets
    // generic wording.
    activity:  { type: String, default: null },
});

// A garbage collector, not the expiry mechanism: Mongo's TTL monitor only runs
// about once a minute, which is far too coarse to decide whether a lock is
// still held. Acquisition compares `expiresAt` itself and takes over an expired
// lock immediately; this index just stops abandoned documents accumulating.
activeLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('ActiveLock', activeLockSchema);
