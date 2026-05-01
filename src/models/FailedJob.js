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
}, { timestamps: true });

// Auto-expire resolved/exhausted records after 30 days
FailedJobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { status: { $in: ['resolved', 'exhausted'] } } });

module.exports = model('FailedJob', FailedJobSchema);
