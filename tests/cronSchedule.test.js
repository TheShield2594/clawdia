'use strict';

// The cron parser behind cron-scheduled tasks. The runner stores an instant and
// asks this for the next one after each run, so what matters is that the next
// one is right in the task's own timezone — across DST, across the day-field
// OR rule, and for expressions that never fire at all.

const { parseCron, nextCronOccurrence, minimumIntervalMinutes, describeCron } = require('../src/utils/cronSchedule');

function next(expression, timeZone, after) {
    const { schedule, error } = parseCron(expression);
    if (error) throw new Error(error);
    return nextCronOccurrence(schedule, timeZone, new Date(after));
}

describe('parseCron', () => {
    test.each([
        ['0 9 * * 1-5'],
        ['*/15 * * * *'],
        ['0 8-18/2 * * *'],
        ['30 6 1,15 * *'],
        ['0 9 * jan-mar mon'],
        ['5/20 * * * *'],
        ['0 0 * * 7'],
        ['@daily'],
        ['  0   9  *  *  *  '],
    ])('reads %p', expression => {
        expect(parseCron(expression).error).toBeUndefined();
    });

    test.each([
        ['', /five fields/],
        ['0 9 * *', /has 4 fields/],
        ['0 9 * * * *', /has 6 fields/],
        ['60 * * * *', /out of range for the minute field/],
        ['0 24 * * *', /out of range for the hour field/],
        ['0 0 0 * *', /out of range for the day of month field/],
        ['0 0 * 13 *', /out of range for the month field/],
        ['0 0 * * 8', /out of range for the day of week field/],
        ['0 17-9 * * *', /runs backwards/],
        ['*/0 * * * *', /whole number of 1 or more/],
        ['0 9 * * L', /out of range/],
        ['1-2-3 * * * *', /not a range/],
    ])('refuses %p in words', (expression, message) => {
        expect(parseCron(expression).error).toMatch(message);
    });

    test('7 is Sunday, the same as 0', () => {
        expect(parseCron('0 0 * * 7').schedule.weekdays).toEqual(new Set([0]));
    });
});

describe('nextCronOccurrence', () => {
    test('weekdays at nine skips the weekend', () => {
        // Friday 2026-07-17 10:00 UTC, past Friday's run.
        expect(next('0 9 * * 1-5', 'Etc/UTC', '2026-07-17T10:00:00Z').toISOString())
            .toBe('2026-07-20T09:00:00.000Z');
    });

    test('is strictly after the given instant', () => {
        expect(next('0 9 * * *', 'Etc/UTC', '2026-07-17T09:00:00Z').toISOString())
            .toBe('2026-07-18T09:00:00.000Z');
    });

    test('reads hours in the task\'s timezone', () => {
        // 09:00 in New York in July is 13:00 UTC.
        expect(next('0 9 * * *', 'America/New_York', '2026-07-17T12:00:00Z').toISOString())
            .toBe('2026-07-17T13:00:00.000Z');
    });

    test('stays at the same local time across a DST change', () => {
        // New York goes back to standard time on 2026-11-01, so 09:00 local
        // moves from 13:00 UTC to 14:00 UTC.
        expect(next('0 9 * * *', 'America/New_York', '2026-10-31T14:00:00Z').toISOString())
            .toBe('2026-11-01T14:00:00.000Z');
    });

    test('skips a wall-clock time that does not exist on the night the clocks go forward', () => {
        // 02:30 does not happen in New York on 2026-03-08.
        expect(next('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z').toISOString())
            .toBe('2026-03-09T06:30:00.000Z');
    });

    test('runs a repeated wall-clock time once when the clocks go back', () => {
        // 01:30 happens twice in New York on 2026-11-01.
        const first = next('30 1 * * *', 'America/New_York', '2026-11-01T04:00:00Z');
        const second = nextCronOccurrence(parseCron('30 1 * * *').schedule, 'America/New_York', first);
        expect(second.getTime() - first.getTime()).toBeGreaterThan(20 * 3_600_000);
    });

    test('fires on either day field when both are restricted', () => {
        // The 1st of the month or a Monday, from Tuesday 2026-07-14.
        expect(next('0 9 1 * 1', 'Etc/UTC', '2026-07-14T00:00:00Z').toISOString())
            .toBe('2026-07-20T09:00:00.000Z');
        expect(next('0 9 1 * 1', 'Etc/UTC', '2026-07-28T00:00:00Z').toISOString())
            .toBe('2026-08-01T09:00:00.000Z');
    });

    test('finds a leap day years ahead', () => {
        expect(next('0 0 29 2 *', 'Etc/UTC', '2026-03-01T00:00:00Z').toISOString())
            .toBe('2028-02-29T00:00:00.000Z');
    });

    test('answers null for a date that never comes', () => {
        expect(next('0 0 31 2 *', 'Etc/UTC', '2026-03-01T00:00:00Z')).toBeNull();
    });
});

describe('minimumIntervalMinutes', () => {
    test.each([
        ['*/15 * * * *', 15],
        ['* * * * *', 1],
        ['0 9 * * *', 1440],
        ['0 */2 * * *', 120],
        ['0,5 * * * *', 5],
        // 23:00 and then 01:00 the next day.
        ['0 1,23 * * *', 120],
    ])('%p is %p minutes', (expression, gap) => {
        expect(minimumIntervalMinutes(parseCron(expression).schedule)).toBe(gap);
    });
});

describe('describeCron', () => {
    test.each([
        ['0 9 * * *', 'daily at 09:00'],
        ['30 8 * * 1-5', 'weekdays at 08:30'],
        ['0 18 * * fri', 'Fri at 18:00'],
        ['0 */2 * * *', 'cron `0 */2 * * *`'],
    ])('%p reads as %p', (expression, label) => {
        expect(describeCron(parseCron(expression).schedule)).toBe(label);
    });
});
