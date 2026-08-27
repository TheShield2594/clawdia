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

// Auto-expire resolved/exhausted records after 30 days
FailedJobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: { $in: ['resolved', 'exhausted'] } } });

module.exports = model('FailedJob', FailedJobSchema);
