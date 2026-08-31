'use strict';

/**
 * The weekly champion race replaced an hourly one, and two pieces of it are new
 * rather than moved: the week key the whole competition is bucketed by, and the
 * accumulating upsert that decides who wins.
 *
 * Both fail quietly. A week key that disagrees with itself across a new year
 * puts two competitions in one bucket — a shared row, and a second payout on a
 * week nobody played. A `best`/`bestDetails` pair that moves apart shows a
 * champion's proudest catch beside a number it never scored.
 */

jest.mock('../src/models/WeeklyChampion', () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
}));

const WeeklyChampion = require('../src/models/WeeklyChampion');
const {
    weekKeyFor,
    getCurrentWeekKey,
    getPreviousWeekKey,
    addWeeklyChampionProgress,
    getWeeklyChampionLeader,
} = require('../src/utils/weeklyChampion');

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    WeeklyChampion.findOneAndUpdate.mockResolvedValue({});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('week keys', () => {
    test('every day of one ISO week lands in the same bucket', () => {
        // Monday 2026-08-24 through Sunday 2026-08-30.
        const keys = new Set();
        for (let day = 24; day <= 30; day++) {
            keys.add(weekKeyFor(new Date(`2026-08-${day}T12:00:00Z`)));
        }
        expect([...keys]).toEqual(['2026-W35']);
    });

    test('the week rolls at Monday 00:00 UTC, where the sweep cron fires', () => {
        expect(weekKeyFor(new Date('2026-08-30T23:59:59Z'))).toBe('2026-W35');
        expect(weekKeyFor(new Date('2026-08-31T00:00:00Z'))).toBe('2026-W36');
    });

    // The calendar year and the ISO week-numbering year are not the same thing
    // in the days either side of New Year. Keying on the calendar year would
    // give the last week of one year and the first of the next the same string.
    test('uses the ISO week-numbering year, not the calendar year', () => {
        expect(weekKeyFor(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
        expect(weekKeyFor(new Date('2027-01-03T12:00:00Z'))).toBe('2026-W53');
        expect(weekKeyFor(new Date('2027-01-04T12:00:00Z'))).toBe('2027-W01');
        expect(weekKeyFor(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01');
    });

    test('the week number is zero-padded so keys sort as text', () => {
        expect(weekKeyFor(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02');
    });

    // The sweep runs minutes into the new week and has to read the one that
    // closed, wherever inside the week it actually fires after an outage.
    test('the previous week is the one before the current one', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:05:00Z'));
        try {
            expect(getCurrentWeekKey()).toBe('2026-W36');
            expect(getPreviousWeekKey()).toBe('2026-W35');
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('addWeeklyChampionProgress', () => {
    test('accumulates the total and the run count for one player and week', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00Z'));
        try {
            await addWeeklyChampionProgress({
                guildId: 'g1', category: 'mine', userId: 'u1', username: 'Ada',
                value: 250, details: '💎 Diamond',
            });

            const [filter, update, options] = WeeklyChampion.findOneAndUpdate.mock.calls[0];
            expect(filter).toEqual({ guildId: 'g1', week: '2026-W35', category: 'mine', userId: 'u1' });
            // A pipeline update Mongoose 9 will actually run — see tests/updatePipelineOption.test.js.
            expect(options).toEqual({ upsert: true, updatePipeline: true });

            const set = update[0].$set;
            expect(set.total).toEqual({ $add: [{ $ifNull: ['$total', 0] }, 250] });
            expect(set.runs).toEqual({ $add: [{ $ifNull: ['$runs', 0] }, 1] });
        } finally {
            jest.useRealTimers();
        }
    });

    // `best` and `bestDetails` have to move together or a row claims its best
    // run was something worth less than the number printed beside it.
    test('the best run and its description are decided by the same comparison', async () => {
        await addWeeklyChampionProgress({
            guildId: 'g1', category: 'mine', userId: 'u1', username: 'Ada',
            value: 250, details: '💎 Diamond',
        });

        const set = WeeklyChampion.findOneAndUpdate.mock.calls[0][1][0].$set;
        expect(set.best).toEqual({ $max: [{ $ifNull: ['$best', 0] }, 250] });
        expect(set.bestDetails).toEqual({
            $cond: [
                { $gt: [250, { $ifNull: ['$best', 0] }] },
                '💎 Diamond',
                { $ifNull: ['$bestDetails', null] },
            ],
        });
    });

    // The claim the sweep makes lives on this row. An upsert that reset it would
    // un-claim a paid champion the moment they played again in the new week.
    test('an upsert never resets a claim or a creation time it did not make', async () => {
        await addWeeklyChampionProgress({
            guildId: 'g1', category: 'hunt', userId: 'u1', username: 'Ada', value: 10,
        });

        const set = WeeklyChampion.findOneAndUpdate.mock.calls[0][1][0].$set;
        expect(set.rewarded).toEqual({ $ifNull: ['$rewarded', false] });
        expect(set.createdAt).toEqual({ $ifNull: ['$createdAt', '$$NOW'] });
    });

    // A blank walk or a failed hunt is not a run. Counting it would let someone
    // climb the board by playing badly often.
    test.each([[0], [-5], [NaN], [Infinity], [undefined], ['300']])(
        'a value of %p is not a run and writes nothing', async value => {
            await addWeeklyChampionProgress({
                guildId: 'g1', category: 'hunt', userId: 'u1', username: 'Ada', value,
            });

            expect(WeeklyChampion.findOneAndUpdate).not.toHaveBeenCalled();
        });

    // Two of a player's runs racing to create the same row is the one error
    // worth retrying: the row exists by the time the retry runs, so the second
    // attempt is an ordinary update and the run still counts. Swallowing it
    // would silently drop the increment.
    test('a lost race to create the row is retried, not swallowed', async () => {
        const dup = Object.assign(new Error('E11000'), { code: 11000 });
        WeeklyChampion.findOneAndUpdate.mockRejectedValueOnce(dup).mockResolvedValueOnce({});

        await addWeeklyChampionProgress({
            guildId: 'g1', category: 'hunt', userId: 'u1', username: 'Ada', value: 10,
        });

        expect(WeeklyChampion.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(errorLog).not.toHaveBeenCalled();
    });

    // Nothing about a command's reply should depend on the scoreboard being up.
    test('a database that is down is reported and does not throw at the caller', async () => {
        WeeklyChampion.findOneAndUpdate.mockRejectedValue(new Error('mongo down'));

        await expect(addWeeklyChampionProgress({
            guildId: 'g1', category: 'hunt', userId: 'u1', username: 'Ada', value: 10,
        })).resolves.toBeUndefined();

        expect(WeeklyChampion.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalled();
    });

    test('a retry that fails too is reported rather than thrown', async () => {
        const dup = Object.assign(new Error('E11000'), { code: 11000 });
        WeeklyChampion.findOneAndUpdate.mockRejectedValue(dup);

        await expect(addWeeklyChampionProgress({
            guildId: 'g1', category: 'hunt', userId: 'u1', username: 'Ada', value: 10,
        })).resolves.toBeUndefined();

        expect(WeeklyChampion.findOneAndUpdate).toHaveBeenCalledTimes(2);
        expect(errorLog).toHaveBeenCalled();
    });
});

describe('getWeeklyChampionLeader', () => {
    test('reads the running week, ranked by total', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00Z'));
        const sort = jest.fn().mockReturnValue({ lean: async () => ({ userId: 'u1', total: 400 }) });
        WeeklyChampion.findOne.mockReturnValue({ sort });
        try {
            const leader = await getWeeklyChampionLeader('g1', 'fish');

            expect(WeeklyChampion.findOne).toHaveBeenCalledWith({ guildId: 'g1', week: '2026-W35', category: 'fish' });
            expect(sort).toHaveBeenCalledWith({ total: -1, runs: -1 });
            expect(leader).toEqual({ userId: 'u1', total: 400 });
        } finally {
            jest.useRealTimers();
        }
    });
});
