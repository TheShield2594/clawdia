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
