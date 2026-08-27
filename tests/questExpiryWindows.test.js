'use strict';

// ensureQuests hands out daily and weekly quests and decides how many are still
// live entirely from the clock: expiry is the next UTC midnight for a daily and
// the next Sunday 00:00 UTC for a weekly, and a quest counts toward a limit only
// when its `expiresAt` matches one of those to the millisecond
// (questService.js:145-193).
//
// Every one of those is a boundary, and none of them could be asserted before
// the clock could be pinned (#632): a suite run on a Tuesday cannot check what
// happens on Saturday, and one run at 23:59 gets a "next midnight" a minute away
// rather than the day the fixtures assume. The Saturday case is the one that
// matters most — the code carries a comment about it, because that is the day
// the daily and weekly expiries are the same instant and an earlier version
// handed out extra quests for it.

const { ensureQuests } = require('../src/services/questService');
const { useFixedClock, setClock, HOUR, DAY } = require('./helpers/fixedClock');

const settings = (overrides = {}) => ({
    quests: { enabled: true, questsPerDay: 3, questsPerWeek: 2, ...overrides },
});

const makeUser = (quests = []) => ({ level: 5, quests });

const nextMidnightUtc = () => {
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    return d;
};

describe('ensureQuests expiry windows', () => {
    // A Thursday, mid-morning: far from both boundaries, so the plain cases
    // below are not accidentally sitting on one.
    useFixedClock('2026-04-16T10:00:00Z');

    test('assigns the configured daily and weekly counts to an empty user', async () => {
        const user = makeUser();
        const { assignedNewDaily } = await ensureQuests(user, settings());

        expect(assignedNewDaily).toBe(true);
        expect(user.quests).toHaveLength(5);

        const dailies = user.quests.filter(q => q.expiresAt.getTime() === Date.parse('2026-04-17T00:00:00Z'));
        const weeklies = user.quests.filter(q => q.expiresAt.getTime() === Date.parse('2026-04-19T00:00:00Z'));
        expect(dailies).toHaveLength(3);
        expect(weeklies).toHaveLength(2);
    });

    test('a second call the same day assigns nothing', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());
        const before = user.quests.map(q => q.questId).sort();

        const { assignedNewDaily } = await ensureQuests(user, settings());

        expect(assignedNewDaily).toBe(false);
        expect(user.quests.map(q => q.questId).sort()).toEqual(before);
    });

    test('dailies expire at midnight UTC and are replaced, weeklies survive', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());
        const weeklyIds = user.quests
            .filter(q => q.expiresAt.getTime() === Date.parse('2026-04-19T00:00:00Z'))
            .map(q => q.questId)
            .sort();

        // A minute past midnight the dailies are gone; the weeklies are not.
        setClock('2026-04-17T00:01:00Z');
        const { assignedNewDaily } = await ensureQuests(user, settings());

        expect(assignedNewDaily).toBe(true);
        expect(user.quests).toHaveLength(5);
        expect(user.quests
            .filter(q => q.expiresAt.getTime() === Date.parse('2026-04-19T00:00:00Z'))
            .map(q => q.questId)
            .sort()).toEqual(weeklyIds);
        expect(user.quests.filter(q => q.expiresAt.getTime() === Date.parse('2026-04-18T00:00:00Z'))).toHaveLength(3);
    });

    test('a minute before midnight the dailies are still live', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());

        setClock('2026-04-16T23:59:00Z');
        const { assignedNewDaily } = await ensureQuests(user, settings());

        expect(assignedNewDaily).toBe(false);
        expect(user.quests).toHaveLength(5);
    });
});

describe('ensureQuests on the Saturday boundary', () => {
    // 2026-04-18 is a Saturday. The next UTC midnight and the next Sunday 00:00
    // are the same instant, so a daily and a weekly quest are indistinguishable
    // by expiry — which is exactly what the classification in ensureQuests is
    // written to survive.
    useFixedClock('2026-04-18T10:00:00Z');

    test('the daily and weekly expiries coincide', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());

        const expiries = new Set(user.quests.map(q => q.expiresAt.getTime()));
        expect([...expiries]).toEqual([Date.parse('2026-04-19T00:00:00Z')]);
        expect(nextMidnightUtc().getTime()).toBe(Date.parse('2026-04-19T00:00:00Z'));
    });

    test('no extra quests are handed out on the boundary day', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());
        expect(user.quests).toHaveLength(5);

        // Counting a quest toward both limits is the safe direction: calling
        // again must not top either list back up to its full count.
        await ensureQuests(user, settings());
        expect(user.quests).toHaveLength(5);
    });

    test('Sunday starts a fresh week rather than expiring into the same one', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());

        // Everything expired at Sunday 00:00; an hour later the whole set is
        // reissued, and the new weeklies run to the *following* Sunday.
        setClock(new Date(Date.parse('2026-04-19T00:00:00Z') + HOUR));
        await ensureQuests(user, settings());

        expect(user.quests).toHaveLength(5);
        expect(user.quests.filter(q => q.expiresAt.getTime() === Date.parse('2026-04-26T00:00:00Z'))).toHaveLength(2);
        expect(user.quests.filter(q => q.expiresAt.getTime() === Date.parse('2026-04-20T00:00:00Z'))).toHaveLength(3);
    });
});

describe('ensureQuests across a DST transition', () => {
    // The last Sunday in March, when European clocks go forward. The service
    // works in UTC throughout, so nothing here should shift by an hour — the
    // point of the test is that it does not.
    useFixedClock('2026-03-29T01:30:00Z');

    test('the daily window is still 24 hours long across the change', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());

        const daily = user.quests.find(q => q.expiresAt.getTime() === Date.parse('2026-03-30T00:00:00Z'));
        expect(daily).toBeDefined();
        expect(daily.expiresAt.getTime() - Date.parse('2026-03-29T00:00:00Z')).toBe(DAY);
    });

    test('a Sunday assigns weeklies that run a full seven days', async () => {
        const user = makeUser();
        await ensureQuests(user, settings());

        const weekly = user.quests.find(q => q.expiresAt.getTime() === Date.parse('2026-04-05T00:00:00Z'));
        expect(weekly).toBeDefined();
        expect(weekly.expiresAt.getTime() - Date.parse('2026-03-29T00:00:00Z')).toBe(7 * DAY);
    });
});

describe('ensureQuests when the feature is off', () => {
    useFixedClock('2026-04-16T10:00:00Z');

    test('assigns nothing and leaves the user untouched', async () => {
        const user = makeUser();
        const result = await ensureQuests(user, { quests: { enabled: false } });
        expect(result).toEqual({ assignedNewDaily: false });
        expect(user.quests).toEqual([]);
    });
});
