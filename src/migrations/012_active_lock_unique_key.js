const mongoose = require('mongoose');

/**
 * Creates the unique index on `activelocks.key`, and refuses to finish without it.
 *
 * The per-user action lock (src/utils/activeGameLock.js) acquires with a
 * conditional upsert. When a live lock already holds the key, the filter misses,
 * the upsert falls through to an insert, and the *unique index* is what rejects
 * that insert — that rejection is the entire "already held" signal. Without the
 * index the insert succeeds instead, two flows both believe they hold the lock,
 * and the thing it exists to prevent happens silently.
 *
 * Mongoose builds indexes declared with `unique: true` on its own, but that
 * build is asynchronous, unordered against the first query, and only logged if
 * it fails. That is fine for an index that makes a lookup faster and not fine
 * for one a correctness argument rests on, so it is created here — before the
 * bot serves anything — and then read back to confirm.
 */
module.exports = {
    name: '012_active_lock_unique_key',

    async up() {
        const locks = mongoose.connection.db.collection('activelocks');

        // A duplicate key left over from a botched earlier build would make the
        // unique build fail; there is nothing worth keeping in a lock document,
        // so clear anything already expired before building.
        await locks.deleteMany({ expiresAt: { $lte: new Date() } }).catch(() => null);

        await locks.createIndex({ key: 1 }, { name: 'idx_activelock_key', unique: true });

        const built = (await locks.indexes()).find(
            i => i.unique === true && Object.keys(i.key).length === 1 && i.key.key === 1,
        );
        if (!built) {
            throw new Error(
                'activelocks.key unique index missing after createIndex — the action lock ' +
                'cannot reject a concurrent acquire without it, so startup must not continue.',
            );
        }
    },

    // Rolling this back re-opens the concurrent-acquire hole described above;
    // it exists for unwinding to a build that predates the conditional-upsert
    // lock, not for running current code without the index.
    async down() {
        const locks = mongoose.connection.db.collection('activelocks');
        await locks.dropIndex('idx_activelock_key').catch(err => {
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
    },
};
