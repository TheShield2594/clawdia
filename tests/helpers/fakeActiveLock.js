'use strict';

/**
 * Stand-in for the ActiveLock model, for tests that drive a command whose
 * `execute` is wrapped in a per-user action lock.
 *
 * The lock is Mongo-backed (see src/utils/activeGameLock.js), so without this
 * the wrapper issues a real query, mongoose buffers it against a connection
 * that will never arrive, and the command under test never runs. The lock is
 * not what those tests are about — tests/activeGameLock.test.js covers its
 * semantics against a fake that models the unique-index behaviour properly.
 *
 * Usage, at the top of a test file:
 *
 *     jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));
 */

const locks = new Map(); // key -> { key, token, expiresAt }

module.exports = {
    __locks: locks,

    async findOneAndUpdate(filter, update, options) {
        const existing = locks.get(filter.key);
        if (existing && existing.expiresAt > filter.expiresAt.$lte) {
            // Still held: the upsert would fall through to an insert the unique
            // index rejects.
            const err = new Error('E11000 duplicate key error');
            err.code = 11000;
            throw err;
        }
        const doc = { ...update.$set };
        locks.set(filter.key, doc);
        return options?.new ? doc : (existing ?? null);
    },

    async deleteOne(filter) {
        const existing = locks.get(filter.key);
        if (!existing || existing.token !== filter.token) return { deletedCount: 0 };
        locks.delete(filter.key);
        return { deletedCount: 1 };
    },
};
