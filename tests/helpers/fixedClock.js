'use strict';

/**
 * Pins the wall clock for a test file (#632).
 *
 * `Date.now()` is read in 116 source files — daily resets keyed on the UTC date
 * string, streaks, cooldowns, weekly-record rollover, seasonal and birthday
 * logic — and until this helper no test stubbed it. Every date-dependent test
 * built its fixtures against whatever the clock happened to say at the moment
 * the suite ran, which works right up until a run straddles a boundary: a
 * fixture captured at 23:59:59.9 UTC and a source read taken a tick later are
 * on different days, and the assertion between them fails. Midnight, the month
 * rollover and a DST transition are the three that will find these, and they
 * find them on someone else's schedule.
 *
 * The pinned clock removes the race: the fixture and the code under test read
 * the same instant, whenever CI happens to run.
 *
 * ## Only Date is faked
 *
 * `jest.useFakeTimers()` with no arguments also takes over setTimeout and
 * friends, which is a much larger change than these suites want — anything
 * awaiting a real timer stops making progress unless the test also drives the
 * scheduler. `doNotFake` leaves every timer API alone, so the only thing that
 * changes is what `Date.now()` and `new Date()` answer. Suites that do want to
 * drive the scheduler should keep calling `jest.useFakeTimers()` directly.
 *
 * ## Usage
 *
 *     const { useFixedClock, advanceClock } = require('./helpers/fixedClock');
 *
 *     describe('weekly rollover', () => {
 *         useFixedClock('2026-03-29T23:30:00Z');
 *         ...
 *         test('rolls over at the boundary', () => {
 *             advanceClock(DAY);   // move the clock, deterministically
 *         });
 *     });
 *
 * Call `useFixedClock` in a `describe` body (or at file top level). It installs
 * the clock in `beforeEach` and restores the real one in `afterEach`, so a
 * clock a test moved with `advanceClock` is back at the pinned instant for the
 * next one.
 */

// Everything except 'Date'. Jest fakes the listed APIs unless they appear here,
// so naming the rest is how you say "fake the clock and nothing else".
const LEAVE_REAL = [
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
];

/**
 * A default instant for suites with no reason to prefer another.
 *
 * Deliberately awkward: 23:30 UTC is inside the last half hour of a UTC day, so
 * a fixture built by subtracting a few hours lands on the previous date; it is
 * the last Sunday in March, the day the EU clocks go forward; and the next day
 * is a month rollover. A suite pinned here is pinned somewhere the three
 * boundaries this issue names are all within a day.
 */
const DEFAULT_CLOCK = '2026-03-29T23:30:00Z';

function toDate(when) {
    const at = when instanceof Date ? new Date(when.getTime()) : new Date(when);
    if (Number.isNaN(at.getTime())) {
        throw new TypeError(`fixedClock: not a usable instant: ${String(when)}`);
    }
    return at;
}

/**
 * Pins the clock for every test in the enclosing describe.
 *
 * @param {string|number|Date} when The instant to pin to. Defaults to
 *   DEFAULT_CLOCK.
 * @returns {Date} The pinned instant, for building fixtures relative to it.
 */
function useFixedClock(when = DEFAULT_CLOCK) {
    const at = toDate(when);

    beforeEach(() => {
        jest.useFakeTimers({ now: at, doNotFake: LEAVE_REAL });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    return at;
}

/** Moves the pinned clock forward (or back, with a negative delta). */
function advanceClock(ms) {
    jest.setSystemTime(Date.now() + ms);
}

/** Moves the pinned clock to a specific instant. */
function setClock(when) {
    jest.setSystemTime(toDate(when));
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;
const WEEK   = 7 * DAY;

module.exports = {
    useFixedClock,
    advanceClock,
    setClock,
    DEFAULT_CLOCK,
    SECOND, MINUTE, HOUR, DAY, WEEK,
};
