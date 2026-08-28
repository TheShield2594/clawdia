// Timezone helpers shared by /timezone, /remind, and the AI reminder ACTION handler.
// No date library dependency — conversions use the standard "guess in UTC, then
// correct using Intl.DateTimeFormat" technique, which is accurate for all real-world
// zones except the exact instant of a DST transition.

const validTimezoneCache = new Set();

function isValidTimezone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    if (validTimezoneCache.has(tz)) return true;
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        validTimezoneCache.add(tz);
        return true;
    } catch {
        return false;
    }
}

/** Resolves a timezone string to its canonical IANA casing (e.g. "america/new_york" -> "America/New_York"). */
function canonicalizeTimezone(tz) {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz }).resolvedOptions().timeZone;
}

function formatToParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        weekday: 'short'
    });
    return dtf.formatToParts(date).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});
}

/** Current wall-clock date/time in `timeZone` as numeric components. */
function nowInTimezone(timeZone, referenceDate = new Date()) {
    const parts = formatToParts(referenceDate, timeZone);
    return {
        year: parseInt(parts.year, 10),
        month: parseInt(parts.month, 10),
        day: parseInt(parts.day, 10),
        hour: parseInt(parts.hour, 10),
        minute: parseInt(parts.minute, 10),
        weekday: parts.weekday
    };
}

/** Converts wall-clock date/time components in `timeZone` to a UTC Date instant. */
function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const parts = formatToParts(new Date(guess), timeZone);
    const asIfLocal = Date.UTC(
        parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
        parseInt(parts.hour, 10), parseInt(parts.minute, 10), parseInt(parts.second, 10)
    );
    const offset = asIfLocal - guess;
    return new Date(guess - offset);
}

/** Formats a Date as "HH:MM" (24h) in the given timezone, for prompts/logging. */
function formatLocalTime(date, timeZone) {
    const parts = formatToParts(date, timeZone);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function to24Hour(hour, ampm) {
    if (!ampm) {
        if (hour < 0 || hour > 23) return null;
        return hour;
    }
    if (hour < 1 || hour > 12) return null;
    const lower = ampm.toLowerCase();
    if (lower === 'am') return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
}

/**
 * Parses a constrained set of absolute-time formats relative to `timeZone`:
 *   "2026-07-20 17:00", "2026-07-20 5:00pm", "17:00", "5:00pm", "9am"
 * Bare times roll forward to the next occurrence (today if still upcoming, else tomorrow).
 * Returns a UTC Date, or null if the string doesn't match a supported format.
 */
function parseAtOption(input, timeZone, now = new Date()) {
    if (typeof input !== 'string') return null;
    const str = input.trim();

    let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (m) {
        const [, y, mo, d, h, mi, ap] = m;
        const hour24 = to24Hour(parseInt(h, 10), ap);
        if (hour24 === null) return null;
        return zonedTimeToUtc(parseInt(y, 10), parseInt(mo, 10), parseInt(d, 10), hour24, parseInt(mi, 10), timeZone);
    }

    m = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!m) m = str.match(/^(\d{1,2})()\s*(am|pm)$/i); // "9am" — no minutes

    if (m) {
        const [, h, mi, ap] = m;
        const hour24 = to24Hour(parseInt(h, 10), ap);
        if (hour24 === null) return null;
        const minute = mi ? parseInt(mi, 10) : 0;

        let { year, month, day } = nowInTimezone(timeZone, now);
        let candidate = zonedTimeToUtc(year, month, day, hour24, minute, timeZone);
        if (candidate.getTime() <= now.getTime()) {
            const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
            year = nextDay.getUTCFullYear();
            month = nextDay.getUTCMonth() + 1;
            day = nextDay.getUTCDate();
            candidate = zonedTimeToUtc(year, month, day, hour24, minute, timeZone);
        }
        return candidate;
    }

    return null;
}

/**
 * Adds `days` calendar days to `date` as measured in `timeZone`, preserving the
 * same local wall-clock hour/minute across the shift (DST-safe — unlike adding
 * a fixed number of milliseconds, this keeps a "9am daily" reminder at 9am
 * local time even when the zone's UTC offset changes in between).
 */
function addCalendarDays(date, days, timeZone) {
    const { year, month, day, hour, minute } = nowInTimezone(timeZone, date);
    const shifted = new Date(Date.UTC(year, month - 1, day + days));
    return zonedTimeToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), hour, minute, timeZone);
}

/**
 * The same date `months` calendar months later, at the same local wall-clock
 * time — the month-shaped sibling of addCalendarDays, for a task that repeats
 * monthly (#834).
 *
 * The day is clamped to the target month's length rather than allowed to roll
 * over: `Date.UTC(y, m, 31)` on a thirty-day month is the 1st of the month
 * after, which would walk a task scheduled for the 31st forward through the
 * calendar a day at a time.
 *
 * Clamping alone is not enough on its own, though, because it is lossy: step
 * from the 31st of January and you land on the 28th of February, and stepping
 * again from *that* gives the 28th of March. The 31st is gone for good after
 * one short month. So the caller may pass the day it actually meant as
 * `anchorDay`, and each step is measured from that rather than from wherever
 * the last clamp landed — 31st, 28th, 31st, 30th, which is what somebody who
 * said "monthly on the 31st" meant. Without it the behaviour is the lossy
 * clamp, which is all a caller with no fixed day of its own needs.
 */
function addCalendarMonths(date, months, timeZone, { anchorDay = null } = {}) {
    const { year, month, day: currentDay, hour, minute } = nowInTimezone(timeZone, date);
    const day = anchorDay || currentDay;

    const zeroBased = month - 1 + months;
    const targetYear = year + Math.floor(zeroBased / 12);
    const targetMonth = ((zeroBased % 12) + 12) % 12; // 0-based, non-negative

    // Day 0 of the next month is the last day of this one.
    const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    return zonedTimeToUtc(targetYear, targetMonth + 1, Math.min(day, daysInMonth), hour, minute, timeZone);
}

module.exports = {
    isValidTimezone,
    canonicalizeTimezone,
    zonedTimeToUtc,
    nowInTimezone,
    formatLocalTime,
    parseAtOption,
    addCalendarDays,
    addCalendarMonths
};
