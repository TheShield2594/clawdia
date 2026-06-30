// Shared helper functions for the dashboard API routes.

// Discord snowflake IDs are 17–20 digit strings.
function isValidDiscordId(id) {
    return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

// H1: Recursively strip any object key starting with '$' to prevent NoSQL operator
// injection. Mongoose schema type validation is the primary defence; this is a
// belt-and-suspenders layer applied before any .set() call.
function sanitizeMongoValue(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sanitizeMongoValue);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('$')) continue;
        out[k] = sanitizeMongoValue(v);
    }
    return out;
}

// L1: Structured audit log — writes to the AuditLog collection. Failures are
// swallowed so audit errors never block the main operation.
async function logAuditEvent(req, guildId, action, details = null) {
    try {
        const AuditLog = require('../../models/AuditLog');
        await AuditLog.create({
            guildId,
            userId:    req.user?.id || 'unknown',
            action,
            ip:        req.ip || null,
            userAgent: req.get('user-agent') || null,
            details,
        });
    } catch (err) {
        console.error('[AUDIT] Failed to write audit event:', err.message);
    }
}

// Filters memberEvents by calendar date rather than array position so sparse
// histories (days with no events) don't skew the 7/30-day windows.
function computeRetention(memberEvents, nowMs = Date.now()) {
    const cutoff7  = new Date(nowMs - 7  * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cutoff30 = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const events7  = memberEvents.filter(e => e.date >= cutoff7);
    const events30 = memberEvents.filter(e => e.date >= cutoff30);
    const joins7   = events7.reduce((a, d) => a + (d.joins  || 0), 0);
    const leaves7  = events7.reduce((a, d) => a + (d.leaves || 0), 0);
    const joins30  = events30.reduce((a, d) => a + (d.joins  || 0), 0);
    const leaves30 = events30.reduce((a, d) => a + (d.leaves || 0), 0);
    const retained7  = joins7  ? Math.max(0, joins7  - leaves7)  / joins7  : 0;
    const retained30 = joins30 ? Math.max(0, joins30 - leaves30) / joins30 : 0;
    return { joins7, leaves7, joins30, leaves30, retained7, retained30 };
}

function median(nums) {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseChannelIdFromJumpUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const parts = url.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : null;
}

module.exports = {
    isValidDiscordId,
    sanitizeMongoValue,
    logAuditEvent,
    computeRetention,
    median,
    parseChannelIdFromJumpUrl,
};
