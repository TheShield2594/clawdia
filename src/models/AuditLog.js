const { Schema, model } = require('mongoose');

const auditLogSchema = new Schema({
    guildId:   { type: String, required: true, index: true },
    userId:    { type: String, required: true },
    action:    { type: String, required: true },
    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },
    details:   { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, index: true }
});

auditLogSchema.index({ guildId: 1, createdAt: -1 });

module.exports = model('AuditLog', auditLogSchema);
