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

module.exports = model('Case', caseSchema);
