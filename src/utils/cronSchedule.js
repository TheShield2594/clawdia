const { nowInTimezone, zonedTimeToUtc } = require('./timezones');

// Cron expressions for scheduled tasks: "every weekday at 9", "every two
// hours", the cadences the named daily/weekly/monthly repeats cannot say.
//
// Hand-rolled rather than borrowed for the same reason timezones.js is: the
// thing a task needs is "the next instant after this one, in this timezone",
// and node-cron (already a dependency) only runs callbacks — it cannot answer
// that question, and the runner stores instants rather than cron lines so it
// can catch up after downtime. The parse is the standard five fields and
// nothing else: no seconds field, no `L`/`W`/`#`, which keeps what an admin
// can type the same as what every cron reference documents.

const FIELDS = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
    // 0 and 7 are both Sunday, as in every cron; 7 is folded into 0 below.
    { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }
];

const MACROS = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *'
};

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// How far ahead the search looks before deciding an expression never fires.
// Long enough for the rarest thing five fields can say — the 29th of February
// on a particular weekday recurs within 28 years, but on any weekday within 8.
const SEARCH_DAYS = 8 * 366;

function parseValue(token, field) {
    const lower = token.toLowerCase();
    if (field.names) {
        const index = field.names.indexOf(lower);
        // Month names count from 1, weekday names from 0.
        if (index !== -1) return index + field.min;
    }
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value >= field.min && value <= field.max ? value : null;
}

/** One field into the sorted set of values it matches, or an error in words. */
function parseField(text, field) {
    const values = new Set();
    for (const part of text.split(',')) {
        const [range, stepText, extra] = part.split('/');
        if (extra !== undefined || !range) return { error: `"${part}" in the ${field.name} field is not something I can read.` };

        let step = 1;
        if (stepText !== undefined) {
            if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
                return { error: `"/${stepText}" in the ${field.name} field needs to be a whole number of 1 or more.` };
            }
            step = Number(stepText);
        }

        let low;
        let high;
        if (range === '*') {
            low = field.min;
            high = field.max;
        } else {
            const [lowText, highText, more] = range.split('-');
            if (more !== undefined) return { error: `"${range}" in the ${field.name} field is not a range I can read.` };
            low = parseValue(lowText, field);
            // `5/15` means "from 5, every 15" — to the end of the field.
            high = highText !== undefined ? parseValue(highText, field) : (stepText !== undefined ? field.max : low);
            if (low === null || high === null) {
                return { error: `"${range}" is out of range for the ${field.name} field (${field.min}–${field.max}).` };
            }
            if (low > high) return { error: `"${range}" in the ${field.name} field runs backwards.` };
        }

        for (let value = low; value <= high; value += step) values.add(value);
    }
    return { values: [...values].sort((a, b) => a - b) };
}

/**
 * Parse a five-field cron expression (or one of the @-macros).
 *
 * Answers `{ schedule }` or `{ error }` in words, the createTask convention:
 * the model is one of the callers, and an error it can read is one it can fix.
 */
function parseCron(expression) {
    if (typeof expression !== 'string' || !expression.trim()) {
        return { error: 'A cron schedule needs five fields: minute hour day-of-month month day-of-week.' };
    }
    const source = expression.trim().replace(/\s+/g, ' ');
    const expanded = MACROS[source.toLowerCase()] || source;
    const parts = expanded.split(' ');
    if (parts.length !== 5) {
        return { error: `"${source}" has ${parts.length} field${parts.length === 1 ? '' : 's'} — a cron schedule has five: minute hour day-of-month month day-of-week.` };
    }

    const sets = [];
    for (let i = 0; i < 5; i++) {
        const { values, error } = parseField(parts[i], FIELDS[i]);
        if (error) return { error };
        sets.push(values);
    }
    const [minutes, hours, days, months, weekdayValues] = sets;
    const weekdays = new Set(weekdayValues.map(day => day % 7));

    return {
        schedule: {
            expression: source,
            minutes,
            hours,
            days: new Set(days),
            months: new Set(months),
            weekdays,
            // The rule every cron has and nobody expects: when both day fields
            // are restricted, a day matching *either* one fires. `0 9 1 * 1` is
            // the 1st of the month and every Monday, not Mondays that fall on
            // the 1st. A field counts as unrestricted only when it starts with
            // `*`, which is how Vixie cron decides it too.
            dayOr: !parts[2].startsWith('*') && !parts[4].startsWith('*')
        }
    };
}

function dayMatches(schedule, day, weekday) {
    const byDate = schedule.days.has(day);
    const byWeekday = schedule.weekdays.has(weekday);
    return schedule.dayOr ? (byDate || byWeekday) : (byDate && byWeekday);
}

/**
 * The first instant strictly after `after` that the schedule fires, in
 * `timeZone`, or null if it never does (`0 0 31 2 *`).
 *
 * Walks local calendar days rather than minutes, so a monthly expression costs
 * a few dozen date conversions rather than forty thousand.
 *
 * A wall-clock time that does not exist — 02:30 on the night the clocks go
 * forward — is skipped, as cron skips it. One that happens twice when they go
 * back runs once, not twice.
 */
function nextCronOccurrence(schedule, timeZone, after) {
    const start = nowInTimezone(timeZone, after);
    // Noon UTC on the local date, stepped a day at a time: far enough from
    // midnight that no offset on earth pushes it onto the neighbouring date.
    let cursor = Date.UTC(start.year, start.month - 1, start.day, 12);

    for (let i = 0; i < SEARCH_DAYS; i++, cursor += 86_400_000) {
        const date = new Date(cursor);
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        if (!schedule.months.has(month)) continue;
        if (!dayMatches(schedule, day, date.getUTCDay())) continue;

        for (const hour of schedule.hours) {
            for (const minute of schedule.minutes) {
                const instant = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
                if (instant.getTime() <= after.getTime()) continue;
                const local = nowInTimezone(timeZone, instant);
                if (local.day !== day || local.hour !== hour || local.minute !== minute) continue;
                return instant;
            }
        }
    }
    return null;
}

/**
 * The shortest gap, in minutes, between two runs of the schedule.
 *
 * Exact without enumerating anything: every day that fires, fires at the same
 * times of day, so the closest two runs can be is either two neighbouring
 * times on one day or the last time on one day and the first on the next.
 * (The second is an underestimate when the next firing day is further off,
 * which errs toward refusing, the safe side for a limit on spending.)
 */
function minimumIntervalMinutes(schedule) {
    const times = [];
    for (const hour of schedule.hours) {
        for (const minute of schedule.minutes) times.push(hour * 60 + minute);
    }
    let gap = 1440 - times[times.length - 1] + times[0];
    for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
    return gap;
}

/** A short plain-language label for the listing, falling back to the expression. */
function describeCron(schedule) {
    const { minutes, hours, days, months, weekdays } = schedule;
    const pad = n => String(n).padStart(2, '0');
    const everyDay = days.size === 31 && months.size === 12;
    if (everyDay && minutes.length === 1 && hours.length === 1) {
        const at = `${pad(hours[0])}:${pad(minutes[0])}`;
        if (weekdays.size === 7) return `daily at ${at}`;
        const names = Object.keys(WEEKDAYS).filter(name => weekdays.has(WEEKDAYS[name]));
        if (names.join() === 'Mon,Tue,Wed,Thu,Fri') return `weekdays at ${at}`;
        return `${names.join(', ')} at ${at}`;
    }
    return `cron \`${schedule.expression}\``;
}

module.exports = { parseCron, nextCronOccurrence, minimumIntervalMinutes, describeCron };
