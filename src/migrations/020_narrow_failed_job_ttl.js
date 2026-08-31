const mongoose = require('mongoose');

/**
 * Replaces the failedjobs TTL so it expires `resolved` records only.
 *
 * The old index — `updatedAt_1`, built by Mongoose from the schema — expired
 * `resolved` **and** `exhausted` records after 30 days (#896). An owed payout
 * that burns through its three retry attempts is marked `exhausted` and, per
 * scripts/replay-owed-payouts.js, left for a human; nothing else in the
 * codebase pays it. Thirty days of nobody looking and the record was gone, and
 * with it the only record that a player was owed coins. The queue that exists
 * so a failed credit survives was deleting exactly the entries that had not
 * been settled.
 *
 * Dropping an index is not something Mongoose does on its own — declaring the
 * narrowed one in the model leaves the old one in place, still deleting
 * exhausted records — so the drop happens here. The replacement is created here
 * too rather than left to autoIndex, so the two swap inside one boot step
 * instead of leaving a window with no TTL at all (the same reasoning as 016).
 *
 * Records already deleted are not recoverable; this stops the next ones going.
 */
module.exports = {
    name: '020_narrow_failed_job_ttl',

    async up() {
        const failedJobs = mongoose.connection.db.collection('failedjobs');

        // A database that never built it — a fresh install, or one already past
        // this — has nothing to drop. NamespaceNotFound (26) is a failedjobs
        // collection that does not exist yet, which is the common case: it is
        // created by the first job failure.
        await failedJobs.dropIndex('updatedAt_1').catch(err => {
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });

        await failedJobs.createIndex(
            { updatedAt: 1 },
            {
                name: 'idx_failedjob_resolved_ttl',
                expireAfterSeconds: 30 * 24 * 60 * 60,
                partialFilterExpression: { status: 'resolved' },
            },
        );

        const built = (await failedJobs.indexes()).find(i => i.name === 'idx_failedjob_resolved_ttl');
        // A TTL that came back covering `exhausted` would delete owed payouts on
        // its next sweep, which is the whole reason this migration exists — so
        // it fails the boot rather than being left to a background sweep nobody
        // is watching.
        if (built?.partialFilterExpression?.status !== 'resolved') {
            throw new Error(
                'failedjobs TTL is not restricted to resolved records after createIndex — ' +
                'exhausted owed payouts would still be deleted, so startup must not continue.',
            );
        }
    },

    // The inverse is the index this replaced, options and unnamed name included.
    // It is a rollback to a state that loses owed payouts, which is what a
    // rollback to the previous release is: the code being rolled back to is the
    // code that wrote the broad filter.
    async down() {
        const failedJobs = mongoose.connection.db.collection('failedjobs');

        await failedJobs.dropIndex('idx_failedjob_resolved_ttl').catch(err => {
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });

        await failedJobs.createIndex(
            { updatedAt: 1 },
            {
                name: 'updatedAt_1',
                expireAfterSeconds: 30 * 24 * 60 * 60,
                partialFilterExpression: { status: { $in: ['resolved', 'exhausted'] } },
            },
        );
    },
};
