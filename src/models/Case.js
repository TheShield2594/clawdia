const { Schema, model } = require('mongoose');

const caseSchema = new Schema({
    caseId: { type: Number, required: true },
    guildId: { type: String, required: true },
    targetUserId: { type: String, required: true },
    moderatorId: { type: String, required: true },
    type: {
        type: String,
        enum: ['warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'note', 'appeal'],
        required: true
    },
    reason: { type: String, required: true },
    duration: { type: Number, default: null },

    evidence: {
        messageId: { type: String, default: null },
        jumpUrl: { type: String, default: null },
        content: { type: String, default: null },
        attachmentUrls: [{ type: String }]
    },

    // A second opinion from the guild's AI provider on a filter trip, when the
    // guild has opted in (`moderation.aiReviewEnabled`, #1017). It changes
    // nothing on its own — the message stays deleted, the case stays filed, and
    // the behaviour score stays applied unless a separate setting says otherwise
    // — it is a note for the human who looks at the case next. Null on cases
    // with no review: AI off, no provider configured, a provider outage, or a
    // budget refusal, all of which cost the case its review and never the case.
    aiReview: {
        verdict: { type: String, enum: ['violation', 'false_positive'], default: null },
        reason:  { type: String, default: null },
        model:   { type: String, default: null },
        at:      { type: Date,   default: null }
    },

    notes: [{
        moderatorId: { type: String, required: true },
        content: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
    }],

    labels: [{ type: String }],
    assignedModId: { type: String, default: null },

    status: {
        type: String,
        enum: ['open', 'closed', 'appealed', 'appeal_approved', 'appeal_denied'],
        default: 'open'
    },

    slaDeadline: { type: Date, default: null },

    // When a moderator first acted on the case after it was opened — the first
    // note, label, assignment or status change (#1015). `createdAt` is when the
    // case was opened, `resolvedAt` when it was closed; the gap between open and
    // *first response* is a different figure from the gap between open and
    // close, and the Insights panel's "Mod SLA" was only ever the latter. Set
    // once and never moved, so it marks the first response and not the most
    // recent one. Null on cases opened before this field existed, and on open
    // cases nobody has touched yet.
    firstActionAt: { type: Date, default: null },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
    resolution: { type: String, default: null },

    createdAt: { type: Date, default: Date.now }
});

caseSchema.index({ guildId: 1, caseId: 1 }, { unique: true });
caseSchema.index({ guildId: 1, targetUserId: 1 });
caseSchema.index({ guildId: 1, status: 1, slaDeadline: 1 });

// The dashboard never reads a guild's cases in natural order: the moderation
// list pages them newest-first (`routes/api/moderation.js`) and the insights
// query takes the newest 1,000 to work out which channels generate incidents
// (`routes/api/stats.js`). Neither of the indexes above orders by createdAt, so
// both sorts were satisfied by fetching every matching case for the guild and
// sorting it in memory — cheap on a server with fifty cases, and the kind of
// cost that only shows up years in (#922).
//
// Declared here rather than in a migration: nothing is being dropped, so
// autoIndex builds it on the next boot (#576).
caseSchema.index({ guildId: 1, createdAt: -1 });

module.exports = model('Case', caseSchema);
