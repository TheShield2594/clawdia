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

// Ceilings for the admin adjust routes (#925).
//
// `Number.isInteger(1e20)` is true, and 1e20 is a hopeless balance: past
// `Number.MAX_SAFE_INTEGER` (9.007e15) the `$inc` arithmetic and the amounts
// the Transaction ledger records stop being exact, so a balance quietly stops
// reconciling and no layer reports anything. Nothing rejects it today, and the
// values are awkward to unwind afterwards.
//
// Two ceilings, because they answer different things. MAX_ADJUST_AMOUNT bounds
// the single give or take, which is the shape a mistyped number arrives in.
// MAX_ADJUST_TOTAL bounds the field afterwards, because a hundred legitimate
// gives reach the same place one absurd one does; the routes clamp inside the
// update rather than reading the balance first, so two admins adjusting at once
// cannot step over it between the read and the write.
//
// Both sit far enough under MAX_SAFE_INTEGER that the clamp's own arithmetic is
// exact: the largest give applied to a balance already at the total is 1.001e15,
// still an exactly representable integer, so the `$min` sees a true value rather
// than a rounded one. The totals are also what keeps `applyXpGain`'s catch-up
// loop (src/services/levelingService.js) finite — it spends XP one level at a
// time, and an unbounded grant is an unbounded loop on the next message.
const MAX_ADJUST_AMOUNT = 1_000_000_000_000;      // 1e12 per give/take
const MAX_ADJUST_TOTAL  = 1_000_000_000_000_000;  // 1e15 balance, XP or level

/**
 * Validates one `amount` field from an adjust route.
 *
 * @param {*} amount raw request value
 * @param {object} [opts]
 * @param {number} [opts.min]   smallest accepted value (1 for give/take, 0 for a set)
 * @param {number} [opts.max]   largest accepted value
 * @param {string} [opts.label] what to call the field in the error
 * @returns {{ value: ?number, error: ?string }} exactly one of the two is set
 */
function readAdjustAmount(amount, { min = 1, max = MAX_ADJUST_AMOUNT, label = 'amount' } = {}) {
    const amt = Number(amount);
    // isSafeInteger rather than isInteger: it rejects 1e20, Infinity and NaN in
    // one go, and every value it accepts survives the arithmetic below it.
    if (!Number.isSafeInteger(amt)) return { value: null, error: `${label} must be an integer` };
    if (amt < min) return { value: null, error: `${label} must be at least ${min.toLocaleString('en-US')}` };
    if (amt > max) return { value: null, error: `${label} must be at most ${max.toLocaleString('en-US')}` };
    return { value: amt, error: null };
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
    MAX_ADJUST_AMOUNT,
    MAX_ADJUST_TOTAL,
    readAdjustAmount,
    sanitizeMongoValue,
    logAuditEvent,
    computeRetention,
    median,
    parseChannelIdFromJumpUrl,
};
