'use strict';

// The three Insights gaps #1015 closed, tested at the pure-helper seam: the
// cohort maturity rule, the heatmap's timezone rotation and its unknown-weekday
// handling. The route wiring around them is covered by statsInsightsQueries;
// this is the arithmetic those tests deliberately do not re-derive.

const {
    finalizeRetentionCohorts,
    startOfIsoWeekUTC,
    tzOffsetMinutes,
    buildActiveHoursHeatmap,
} = require('../src/dashboard/lib/apiHelpers');

const DAY = 24 * 60 * 60 * 1000;

describe('finalizeRetentionCohorts', () => {
    // A cohort whose week ended `weekEndDaysAgo` days before NOW.
    const NOW = new Date('2026-04-01T00:00:00Z').getTime();
    const weekStartFor = weekEndDaysAgo => new Date(NOW - weekEndDaysAgo * DAY - 7 * DAY);

    test('reports a window only once the whole cohort has had that long to churn', () => {
        // Week ended 10 days ago: D1 and D7 are ripe, D30 is not.
        const rows = [{ _id: weekStartFor(10), size: 10, r1: 9, r7: 6, r30: 4 }];
        const [cohort] = finalizeRetentionCohorts(rows, NOW);

        expect(cohort.d1Pct).toBe(90);
        expect(cohort.d7Pct).toBe(60);
        // Not zero — pending, because the cohort is not 30 days old yet.
        expect(cohort.d30Pct).toBeNull();
    });

    test('a fully mature cohort reports every window', () => {
        const rows = [{ _id: weekStartFor(40), size: 20, r1: 20, r7: 15, r30: 10 }];
        const [cohort] = finalizeRetentionCohorts(rows, NOW);

        expect(cohort.d1Pct).toBe(100);
        expect(cohort.d7Pct).toBe(75);
        expect(cohort.d30Pct).toBe(50);
    });

    test('a brand-new cohort has no ripe window yet', () => {
        const rows = [{ _id: weekStartFor(0), size: 5, r1: 5, r7: 0, r30: 0 }];
        const [cohort] = finalizeRetentionCohorts(rows, NOW);

        // The week only just ended, so even D1 needs another day.
        expect(cohort.d1Pct).toBeNull();
        expect(cohort.d7Pct).toBeNull();
        expect(cohort.d30Pct).toBeNull();
        expect(cohort.size).toBe(5);
    });

    test('an empty mature cohort divides to zero, not NaN', () => {
        const rows = [{ _id: weekStartFor(40), size: 0, r1: 0, r7: 0, r30: 0 }];
        const [cohort] = finalizeRetentionCohorts(rows, NOW);
        expect(cohort.d30Pct).toBe(0);
    });

    test('drops rows with no week and tolerates empty input', () => {
        expect(finalizeRetentionCohorts(null)).toEqual([]);
        expect(finalizeRetentionCohorts([{ _id: null, size: 3 }])).toEqual([]);
    });

    test('labels the cohort by its ISO week-start date', () => {
        const weekStart = new Date('2026-03-02T00:00:00Z'); // a Monday
        const [cohort] = finalizeRetentionCohorts([{ _id: weekStart, size: 1, r1: 1, r7: 1, r30: 1 }], NOW);
        expect(cohort.cohort).toBe('2026-03-02');
    });
});

describe('startOfIsoWeekUTC', () => {
    const iso = ms => new Date(startOfIsoWeekUTC(ms)).toISOString();

    test('floors a mid-week instant to its Monday 00:00 UTC', () => {
        // 2026-04-01 is a Wednesday → Monday of that week is 2026-03-30.
        expect(iso(Date.parse('2026-04-01T15:30:00Z'))).toBe('2026-03-30T00:00:00.000Z');
    });

    test('leaves a Monday on itself', () => {
        expect(iso(Date.parse('2026-03-30T00:00:00Z'))).toBe('2026-03-30T00:00:00.000Z');
    });

    test('treats Sunday as the end of the week, not the start', () => {
        // 2026-04-05 is a Sunday → still belongs to the week starting 2026-03-30.
        expect(iso(Date.parse('2026-04-05T23:00:00Z'))).toBe('2026-03-30T00:00:00.000Z');
    });
});

describe('tzOffsetMinutes', () => {
    test('UTC and an unknown zone are zero', () => {
        expect(tzOffsetMinutes('UTC')).toBe(0);
        expect(tzOffsetMinutes('Not/AZone')).toBe(0);
        expect(tzOffsetMinutes('')).toBe(0);
    });

    test('a fixed-offset zone is exact', () => {
        // Asia/Kolkata is UTC+5:30 year round.
        expect(tzOffsetMinutes('Asia/Kolkata', new Date('2026-06-01T00:00:00Z'))).toBe(330);
    });

    test('a DST zone is read at the reference instant', () => {
        // New York: −4h in July (EDT), −5h in January (EST).
        expect(tzOffsetMinutes('America/New_York', new Date('2026-07-01T12:00:00Z'))).toBe(-240);
        expect(tzOffsetMinutes('America/New_York', new Date('2026-01-01T12:00:00Z'))).toBe(-300);
    });
});

describe('buildActiveHoursHeatmap', () => {
    test('UTC leaves the buckets where they are', () => {
        // Monday (weekday 1) at 14:00 UTC, three times.
        const entries = Array.from({ length: 3 }, () => ({ hour: 14, weekday: 1 }));
        const hm = buildActiveHoursHeatmap(entries, 'UTC');

        expect(hm.timezone).toBe('UTC');
        expect(hm.grid).toHaveLength(7);
        expect(hm.grid[1][14]).toBe(3);
        expect(hm.total).toBe(3);
        expect(hm.hasUnknown).toBe(false);
    });

    test('a positive offset can roll an hour past midnight into the next day', () => {
        // 23:00 UTC Monday, +5:30 → 04:30 local Tuesday: hour 4, weekday 2.
        const hm = buildActiveHoursHeatmap([{ hour: 23, weekday: 1 }], 'Asia/Kolkata',
            new Date('2026-06-01T00:00:00Z'));
        expect(hm.grid[2][4]).toBe(1);
        expect(hm.grid[1][23]).toBe(0);
    });

    test('a negative offset can roll back into the previous day', () => {
        // 02:00 UTC Monday, −5h (EST) → 21:00 local Sunday: hour 21, weekday 0.
        const hm = buildActiveHoursHeatmap([{ hour: 2, weekday: 1 }], 'America/New_York',
            new Date('2026-01-01T12:00:00Z'));
        expect(hm.grid[0][21]).toBe(1);
    });

    test('entries with no weekday land on the unknown row, hour still shifted', () => {
        // Legacy entry: hour but no weekday. +5:30 shifts 20:00 → 01:30 → hour 1.
        const hm = buildActiveHoursHeatmap([{ hour: 20 }], 'Asia/Kolkata',
            new Date('2026-06-01T00:00:00Z'));
        expect(hm.hasUnknown).toBe(true);
        expect(hm.unknownWeekday[1]).toBe(1);
        // Nothing landed on a real weekday.
        expect(hm.grid.every(row => row.every(v => v === 0))).toBe(true);
    });

    test('ignores entries with an out-of-range or missing hour', () => {
        const hm = buildActiveHoursHeatmap(
            [{ hour: 24, weekday: 1 }, { hour: -1, weekday: 1 }, { weekday: 1 }, { hour: 5, weekday: 1 }],
            'UTC');
        expect(hm.total).toBe(1);
        expect(hm.grid[1][5]).toBe(1);
    });

    test('places an entry from its createdAt timestamp, exactly, in the zone', () => {
        // 2026-06-01 20:00 UTC is a Monday; in Asia/Kolkata (+5:30) that is
        // Tuesday 01:30 → weekday 2, hour 1. Read from the timestamp, so the
        // half-hour offset lands on the right hour where the stored-hour
        // fallback (whole-hour shift) could not.
        const hm = buildActiveHoursHeatmap([{ createdAt: '2026-06-01T20:00:00Z' }], 'Asia/Kolkata');
        expect(hm.grid[2][1]).toBe(1);
        expect(hm.total).toBe(1);
        expect(hm.hasUnknown).toBe(false);
    });

    test('uses the per-event offset across a daylight-saving change', () => {
        // New York is EST (−5) in January and EDT (−4) in July. Two 12:00 UTC
        // events land on 07:00 and 08:00 local respectively — a single offset
        // could not place both.
        const hm = buildActiveHoursHeatmap([
            { createdAt: '2026-01-15T12:00:00Z' },
            { createdAt: '2026-07-15T12:00:00Z' },
        ], 'America/New_York');
        // 2026-01-15 is a Thursday (4), 2026-07-15 is a Wednesday (3).
        expect(hm.grid[4][7]).toBe(1);
        expect(hm.grid[3][8]).toBe(1);
    });

    test('falls back to the stored hour/weekday when createdAt is absent', () => {
        const hm = buildActiveHoursHeatmap([{ hour: 14, weekday: 1 }], 'UTC');
        expect(hm.grid[1][14]).toBe(1);
    });
});
