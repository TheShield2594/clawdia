'use strict';

// getActiveSeasonalEvent() is calendar logic and nothing else: it reads
// `new Date()`, reduces it to a UTC month and day, and answers with whichever
// event's window contains them (data/seasonalEvents.js:216-229). Untested until
// now, and untestable in any useful way without stubbing the clock — a test
// written against the real one asserts a different answer every month, so the
// only assertions that could survive were the ones that said nothing (#632).
//
// With the clock pinned each window can be walked at both of its edges, which
// is where an off-by-one in a `>= dayStart && <= dayEnd` lives.

const { getActiveSeasonalEvent, SEASONAL_EVENTS } = require('../src/data/seasonalEvents');
const { useFixedClock, setClock, advanceClock, DAY } = require('./helpers/fixedClock');

const idAt = (when) => {
    setClock(when);
    return getActiveSeasonalEvent()?.id ?? null;
};

describe('getActiveSeasonalEvent', () => {
    useFixedClock();

    test('every configured window is claimed by its own event on its first and last day', () => {
        for (const event of Object.values(SEASONAL_EVENTS)) {
            const { month, dayStart, dayEnd } = event.autoStart;
            const mm = String(month).padStart(2, '0');
            for (const day of [dayStart, dayEnd]) {
                const dd = String(day).padStart(2, '0');
                expect(idAt(`2026-${mm}-${dd}T12:00:00Z`)).toBe(event.id);
            }
        }
    });

    test('no two windows overlap', () => {
        // Two events claiming the same day would make the answer depend on
        // object key order, which is not something the data file states.
        const claimed = new Map();
        for (const event of Object.values(SEASONAL_EVENTS)) {
            const { month, dayStart, dayEnd } = event.autoStart;
            for (let day = dayStart; day <= dayEnd; day++) {
                const key = `${month}-${day}`;
                expect(claimed.get(key) ?? event.id).toBe(event.id);
                claimed.set(key, event.id);
            }
        }
    });

    test('the day before a window opens is outside it', () => {
        // Valentine's runs Feb 7-14, so the 6th and the 15th are quiet days —
        // and quiet is the answer no other window claims either.
        expect(idAt('2026-02-06T12:00:00Z')).toBeNull();
        expect(idAt('2026-02-07T00:00:00Z')).toBe('valentines_day');
        expect(idAt('2026-02-14T23:59:59Z')).toBe('valentines_day');
        expect(idAt('2026-02-15T12:00:00Z')).toBeNull();
    });

    test('the winter hunt ends on the 14th of January and December is a different event', () => {
        expect(idAt('2026-01-14T23:00:00Z')).toBe('winter_hunt');
        expect(idAt('2026-01-15T01:00:00Z')).toBeNull();
        expect(idAt('2026-12-25T12:00:00Z')).toBe('winter_wonderland');
    });

    test('a month rollover past midnight UTC changes the answer', () => {
        // 23:30 UTC on the last day of October is still Spooky Season; an hour
        // later it is November and nothing is running. The window is read from
        // the clock at call time, not from whenever the process started.
        setClock('2026-10-31T23:30:00Z');
        expect(getActiveSeasonalEvent()?.id).toBe('spooky_season');

        advanceClock(60 * 60 * 1000);
        expect(getActiveSeasonalEvent()).toBeNull();
    });

    test('a leap day falls outside every window', () => {
        // Feb 29 exists only in leap years and sits past Valentine's dayEnd, so
        // it must not resolve to an event by accident.
        expect(idAt('2028-02-29T12:00:00Z')).toBeNull();
    });

    test('walking a full year visits each event and never throws', () => {
        const seen = new Set();
        setClock('2026-01-01T12:00:00Z');
        for (let i = 0; i < 365; i++) {
            const event = getActiveSeasonalEvent();
            if (event) seen.add(event.id);
            advanceClock(DAY);
        }
        expect([...seen].sort()).toEqual(Object.keys(SEASONAL_EVENTS).sort());
    });
});
