const { Schema, model } = require('mongoose');

const FailedJobSchema = new Schema({
    service: { type: String, required: true, index: true },
    jobName: { type: String, required: true },
    guildId: { type: String, default: null, index: true },
    payload: { type: Schema.Types.Mixed, default: null },
    errorMessage: { type: String, required: true },
    errorStack: { type: String, default: null },
    attempts: { type: Number, default: 1 },
    maxAttempts: { type: Number, default: 3 },
    status: {
        type: String,
        enum: ['pending', 'retrying', 'exhausted', 'resolved'],
        default: 'pending',
        index: true,
    },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
    lastAttemptAt: { type: Date, default: Date.now },

    // Lease held by an in-flight retry, and who holds it. `status: 'retrying'`
    // alone cannot say whether a replay is running or whether the process
    // running it died, and retrying a live one runs its handler twice — for an
    // owed payout, a second credit. Null means nobody holds it; a timestamp
    // older than RETRY_LEASE_MS in src/utils/jobRunner.js means the holder is
    // gone and the record can be taken. Absent on records written before this
    // field existed, which `{ claimedAt: null }` matches, so they are claimable
    // without a migration.
    claimedAt: { type: Date, default: null },
    claimedBy: { type: String, default: null },
}, { timestamps: true });

// Auto-expire *resolved* records after 30 days.
//
// `exhausted` was in this filter too (#896), which meant the TTL deleted
// precisely the records that most needed a human. An owed payout that burns
// through its three attempts is marked `exhausted` and, per
// scripts/replay-owed-payouts.js, "left for a human" — nothing else in the
// codebase pays it. Thirty days later the record went away and the debt with
// it: a player owed coins by a failed payout simply lost the claim, silently.
//
// This queue is the compensation mechanism behind every money path that cannot
// use a transaction, so the records have to outlive an operator's attention
// span. A resolved one has been paid and is history; an exhausted one is an
// outstanding debt, and an outstanding debt does not expire.
//
// `pending` and `retrying` were never covered by the TTL and still are not, for
// the same reason: they are work that has not been done yet.
//
// Named, because the index it replaces was not: Mongoose called that one
// `updatedAt_1`, and a second index on the same key with different options is
// an IndexOptionsConflict rather than an update. Migration
// 020_narrow_failed_job_ttl drops it — declaring this one leaves the old one
// exactly where it is, still deleting exhausted records.
FailedJobSchema.index(
    { updatedAt: 1 },
    {
        name: 'idx_failedjob_resolved_ttl',
        expireAfterSeconds: 30 * 24 * 60 * 60,
        partialFilterExpression: { status: 'resolved' },
    },
);

module.exports = model('FailedJob', FailedJobSchema);
