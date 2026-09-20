const { Schema, model } = require('mongoose');

const auditLogSchema = new Schema({
    guildId:   { type: String, required: true, index: true },
    userId:    { type: String, required: true },
    action:    { type: String, required: true },
    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },
    details:   { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now }
});

auditLogSchema.index({ guildId: 1, createdAt: -1 });

// TTL: automatically expire records that carry PII (ip address) after a
// configurable retention period. Records without an ip field (those that don't
// originate from an HTTP request) are unaffected by this index.
//
// createdAt must NOT also carry `index: true` on the field above. Both
// definitions default to the index name `createdAt_1`, so the plain one is
// created first and MongoDB then rejects this one as a conflicting spec under
// a name that already exists — silently, apart from a Mongoose warning at boot.
// The result is an index that looks present and expires nothing.
const retentionDays = Math.max(1, parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10));
auditLogSchema.index(
    { createdAt: 1 },
    {
        expireAfterSeconds: retentionDays * 24 * 60 * 60,
        partialFilterExpression: { ip: { $type: 'string' } },
    }
);

module.exports = model('AuditLog', auditLogSchema);
