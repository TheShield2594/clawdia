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
    // `Number()` answers 0 for null, undefined, '', '  ', [] and false, and a
    // route whose minimum is 0 — set_level — would take that as "level 0" and
    // wipe the member's level on a request that named no amount at all. Only a
    // number or a non-blank string is an amount; everything else is a missing
    // field, not a zero.
    const isNumeric = typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '');
    if (!isNumeric) return { value: null, error: `${label} must be an integer` };

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

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Turns the join-week aggregation into the cohort rows the panel draws (#1015).
 *
 * The aggregation groups members by the week they joined and counts, per
 * window, how many were still members that long after joining (`tenureMs` is
 * `leftAt − joinedAt`, or `now − joinedAt` for a member still present, so
 * `tenureMs ≥ N days` is exactly "retained at day N"). What it cannot decide is
 * whether a window is *ripe*: a cohort that joined ten days ago has no honest
 * D30 figure, because its members have not had thirty days to leave — counting
 * them as churned would read as a retention cliff that is really just the
 * present catching up. So a window is reported only once the whole cohort has
 * had time to reach it (the latest possible join in the week, plus the window,
 * is in the past); until then it is null, and the panel shows it as pending
 * rather than as zero.
 *
 * @param {{_id: (Date|string), size: number, r1: number, r7: number, r30: number}[]} rows
 * @param {number} [nowMs]
 * @returns {{cohort: string, size: number, d1Pct: ?number, d7Pct: ?number, d30Pct: ?number}[]}
 */
function finalizeRetentionCohorts(rows, nowMs = Date.now()) {
    return (rows || [])
        .filter(row => row && row._id)
        .map(row => {
            const weekStart = new Date(row._id);
            // The last member counted in this cohort could have joined right up
            // to the end of the week, so maturity is measured from the week's
            // end, not its start.
            const weekEnd = weekStart.getTime() + 7 * DAY_MS;
            const size = row.size || 0;
            const pct = (retained, windowDays) => {
                if (nowMs < weekEnd + windowDays * DAY_MS) return null;
                return size ? Number(((retained / size) * 100).toFixed(1)) : 0;
            };
            return {
                cohort: weekStart.toISOString().slice(0, 10),
                size,
                d1Pct:  pct(row.r1 || 0, 1),
                d7Pct:  pct(row.r7 || 0, 7),
                d30Pct: pct(row.r30 || 0, 30),
            };
        });
}

/**
 * Minutes to add to a UTC clock to read it in `timeZone` at `at` — positive
 * east of UTC. Used to rotate the UTC activity buckets into the guild's own
 * time (#1015). It is the offset in effect at one reference instant, so a
 * fixed-offset zone is exact and a DST zone is read at whichever side of the
 * changeover `at` falls on; the buckets carry only a UTC hour and weekday, not
 * a date, so an offset is the most a UTC-only bucket can honestly be shifted by.
 *
 * @param {string} timeZone an IANA zone name, e.g. 'America/New_York'.
 * @param {Date} [at]
 * @returns {number} offset in minutes, or 0 if the zone is not understood.
 */
function tzOffsetMinutes(timeZone, at = new Date()) {
    if (!timeZone || timeZone === 'UTC') return 0;
    try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(at).map(p => [p.type, p.value]));
        // `hour` comes back as '24' at midnight in some engines; fold it to 0.
        const hour = Number(parts.hour) % 24;
        const asUTC = Date.UTC(
            Number(parts.year), Number(parts.month) - 1, Number(parts.day),
            hour, Number(parts.minute), Number(parts.second),
        );
        return Math.round((asUTC - at.getTime()) / 60000);
    } catch {
        return 0;
    }
}

/**
 * Builds the 7×24 weekday-by-hour activity grid for the Insights heatmap
 * (#1015), rotated from the UTC buckets into `timeZone`.
 *
 * Each command-usage entry carries a UTC `hour` and (since #1015) a UTC
 * `weekday`. Entries written before the weekday field have none, and their day
 * cannot be recovered, so they are kept on a separate `unknownWeekday` row by
 * hour rather than dropped or guessed onto a day they may not have run on. The
 * hour, which every entry has, is still shifted into the zone for that row.
 *
 * @param {{hour: number, weekday: ?number}[]} entries
 * @param {string} [timeZone]
 * @param {Date} [at] reference instant for the zone offset.
 * @returns {{timezone: string, weekdays: string[], grid: number[][],
 *            unknownWeekday: number[], hasUnknown: boolean, total: number}}
 */
function buildActiveHoursHeatmap(entries, timeZone = 'UTC', at = new Date()) {
    const offsetMinutes = tzOffsetMinutes(timeZone, at);
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const unknownWeekday = new Array(24).fill(0);
    let total = 0;
    let hasUnknown = false;

    for (const entry of entries || []) {
        const hour = Number(entry?.hour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
        total += 1;

        const weekday = entry?.weekday;
        const hasWeekday = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6;

        // Shift the whole (weekday, hour) position by the offset so a bucket
        // that rolls past midnight lands on the next or previous day.
        const localHourFloat = (hour * 60 + offsetMinutes) / 60;
        const dayShift = Math.floor(localHourFloat / 24);
        const localHour = ((Math.floor(localHourFloat) % 24) + 24) % 24;

        if (hasWeekday) {
            const localWeekday = (((weekday + dayShift) % 7) + 7) % 7;
            grid[localWeekday][localHour] += 1;
        } else {
            hasUnknown = true;
            // No day to shift, but the hour still moves into the zone.
            unknownWeekday[localHour] += 1;
        }
    }

    return {
        timezone: timeZone || 'UTC',
        weekdays: WEEKDAY_LABELS,
        grid,
        unknownWeekday,
        hasUnknown,
        total,
    };
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
    finalizeRetentionCohorts,
    tzOffsetMinutes,
    buildActiveHoursHeatmap,
    WEEKDAY_LABELS,
};
