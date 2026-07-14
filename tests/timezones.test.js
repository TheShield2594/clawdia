'use strict';

const {
    isValidTimezone,
    zonedTimeToUtc,
    nowInTimezone,
    formatLocalTime,
    parseAtOption
} = require('../src/utils/timezones');

describe('isValidTimezone', () => {
    test('accepts valid IANA timezones', () => {
        expect(isValidTimezone('America/New_York')).toBe(true);
        expect(isValidTimezone('Etc/UTC')).toBe(true);
        expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    });

    test('rejects invalid or non-string input', () => {
        expect(isValidTimezone('Not/AZone')).toBe(false);
        expect(isValidTimezone('')).toBe(false);
        expect(isValidTimezone(null)).toBe(false);
        expect(isValidTimezone(undefined)).toBe(false);
        expect(isValidTimezone(123)).toBe(false);
    });
});

describe('zonedTimeToUtc', () => {
    test('converts EDT (summer) wall-clock time to UTC correctly', () => {
        // July: America/New_York is UTC-4 (EDT)
        const d = zonedTimeToUtc(2026, 7, 14, 17, 0, 'America/New_York');
        expect(d.toISOString()).toBe('2026-07-14T21:00:00.000Z');
    });

    test('converts EST (winter) wall-clock time to UTC correctly', () => {
        // January: America/New_York is UTC-5 (EST)
        const d = zonedTimeToUtc(2026, 1, 14, 17, 0, 'America/New_York');
        expect(d.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    });

    test('UTC timezone is a no-op conversion', () => {
        const d = zonedTimeToUtc(2026, 3, 1, 12, 30, 'Etc/UTC');
        expect(d.toISOString()).toBe('2026-03-01T12:30:00.000Z');
    });
});

describe('nowInTimezone', () => {
    test('reports correct wall-clock components for a known instant', () => {
        const ref = new Date('2026-07-14T21:00:00.000Z');
        const parts = nowInTimezone('America/New_York', ref);
        expect(parts).toMatchObject({ year: 2026, month: 7, day: 14, hour: 17, minute: 0 });
    });
});

describe('formatLocalTime', () => {
    test('formats a UTC instant in the target timezone', () => {
        const d = new Date('2026-07-20T13:00:00.000Z');
        expect(formatLocalTime(d, 'America/New_York')).toBe('2026-07-20 09:00');
    });
});

describe('parseAtOption', () => {
    const tz = 'America/New_York';

    test('parses a full date + 24h time', () => {
        const now = new Date('2026-07-14T20:00:00Z');
        const result = parseAtOption('2026-07-20 09:00', tz, now);
        expect(result.toISOString()).toBe('2026-07-20T13:00:00.000Z');
    });

    test('parses a full date + 12h time with am/pm', () => {
        const now = new Date('2026-07-14T20:00:00Z');
        const result = parseAtOption('2026-07-20 5:00pm', tz, now);
        expect(result.toISOString()).toBe('2026-07-20T21:00:00.000Z');
    });

    test('bare time later today rolls to today', () => {
        // now = 4pm ET
        const now = new Date('2026-07-14T20:00:00Z');
        const result = parseAtOption('5pm', tz, now);
        expect(result.toISOString()).toBe('2026-07-14T21:00:00.000Z');
    });

    test('bare time already passed today rolls to tomorrow', () => {
        // now = 4pm ET
        const now = new Date('2026-07-14T20:00:00Z');
        const result = parseAtOption('3:00pm', tz, now);
        expect(result.toISOString()).toBe('2026-07-15T19:00:00.000Z');
    });

    test('hour-only am/pm format ("9am") is supported', () => {
        const now = new Date('2026-07-14T04:00:00Z'); // midnight ET
        const result = parseAtOption('9am', tz, now);
        expect(result.toISOString()).toBe('2026-07-14T13:00:00.000Z');
    });

    test('returns null for unparseable input', () => {
        expect(parseAtOption('whenever', tz)).toBeNull();
        expect(parseAtOption('', tz)).toBeNull();
        expect(parseAtOption(undefined, tz)).toBeNull();
    });
});
