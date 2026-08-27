'use strict';

// Digest scheduling survives downtime and slow ticks (#824). The scheduler
// used to match due jobs by hour/minute *equality*, so a tick lost to the
// overlap guard — or the bot being down at the configured minute — silently
// cost the whole day's run. It now scans for "the configured time has passed
// and the last run is stale", claiming the daily slot atomically before the
// run, the way the newspaper does.

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../src/utils/jobRunner', () => ({
    runJob: (service, name, fn) => fn()
}));
jest.mock('../src/services/aiService', () => ({
    getCompletion: jest.fn(async () => 'summary'),
    resolveProviderConfig: jest.fn(() => ({}))
}));

const mockJobFind = jest.fn(async () => []);
const mockJobClaim = jest.fn(async () => null);
jest.mock('../src/models/SummaryJob', () => ({
    find: (...args) => mockJobFind(...args),
    findOneAndUpdate: (...args) => mockJobClaim(...args)
}));

const mockGuildFind = jest.fn(() => ({ lean: () => Promise.resolve([]) }));
const mockGuildClaim = jest.fn(async () => null);
jest.mock('../src/models/Guild', () => ({
    find: (...args) => mockGuildFind(...args),
    findOne: jest.fn(async () => null),
    findOneAndUpdate: (...args) => mockGuildClaim(...args)
}));

const { __test__ } = require('../src/services/summaryService');
const { runSchedulerTick, timeHasPassed, REFIRE_GUARD_MS } = __test__;

// A client whose guild fetch always fails: the claimed run then returns
// early, which is fine — these tests are about whether the slot is claimed,
// not what the run posts.
const client = { guilds: { fetch: jest.fn(async () => { throw new Error('gone'); }) } };

const NOW = new Date('2026-08-27T12:30:00Z');
const hoursAgo = h => new Date(NOW.getTime() - h * 60 * 60 * 1000);

beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.clearAllMocks();
    mockGuildFind.mockImplementation(() => ({ lean: () => Promise.resolve([]) }));
    mockJobFind.mockResolvedValue([]);
});

afterEach(() => jest.useRealTimers());

describe('timeHasPassed', () => {
    test('is a window to midnight, not the exact minute', () => {
        expect(timeHasPassed(12, 30, 9, 0)).toBe(true);
        expect(timeHasPassed(9, 0, 9, 0)).toBe(true);
        expect(timeHasPassed(9, 1, 9, 0)).toBe(true);
        expect(timeHasPassed(8, 59, 9, 0)).toBe(false);
        expect(timeHasPassed(9, 0, 9, 1)).toBe(false);
    });
});

describe('summary jobs', () => {
    const job = (over = {}) => ({
        _id: 'j1', guildId: 'g1', label: 'daily', hour: 9, minute: 0,
        lastRun: hoursAgo(24), ...over
    });

    test('the query asks for jobs whose time has passed, not the exact minute', async () => {
        await runSchedulerTick(client);

        expect(mockJobFind).toHaveBeenCalledWith({
            enabled: true,
            $or: [{ hour: { $lt: 12 } }, { hour: 12, minute: { $lte: 30 } }]
        });
    });

    test('a job missed at its minute is claimed on a later tick', async () => {
        mockJobFind.mockResolvedValue([job()]);
        mockJobClaim.mockResolvedValue(job({ lastRun: NOW }));

        await runSchedulerTick(client);

        expect(mockJobClaim).toHaveBeenCalledWith(
            expect.objectContaining({ _id: 'j1', enabled: true }),
            { $set: { lastRun: NOW } },
            { new: true }
        );
    });

    test('a job that already ran today is left alone', async () => {
        mockJobFind.mockResolvedValue([job({ lastRun: hoursAgo(3) })]);

        await runSchedulerTick(client);

        expect(mockJobClaim).not.toHaveBeenCalled();
    });

    test('a lost claim race does not run the job', async () => {
        mockJobFind.mockResolvedValue([job()]);
        mockJobClaim.mockResolvedValue(null);

        await runSchedulerTick(client);

        expect(client.guilds.fetch).not.toHaveBeenCalled();
    });
});

describe('guild daily digests', () => {
    const digestGuild = (over = {}) => ({
        guildId: 'g1',
        ai: { dailyDigest: { enabled: true, channelId: 'c1', hour: 9, minute: 0, timezone: 'UTC', lastRun: hoursAgo(24), ...over } }
    });

    test('a digest missed at its minute is claimed on a later tick', async () => {
        mockGuildFind.mockImplementation(() => ({ lean: () => Promise.resolve([digestGuild()]) }));
        mockGuildClaim.mockResolvedValue({ guildId: 'g1' });

        await runSchedulerTick(client);

        expect(mockGuildClaim).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: 'g1', 'ai.dailyDigest.enabled': true }),
            { $set: { 'ai.dailyDigest.lastRun': NOW } }
        );
    });

    test('a digest whose time has not come yet is not claimed', async () => {
        mockGuildFind.mockImplementation(() => ({ lean: () => Promise.resolve([digestGuild({ hour: 15 })]) }));

        await runSchedulerTick(client);

        expect(mockGuildClaim).not.toHaveBeenCalled();
    });

    test('a digest that already ran today is not claimed again', async () => {
        mockGuildFind.mockImplementation(() => ({ lean: () => Promise.resolve([digestGuild({ lastRun: hoursAgo(2) })]) }));

        await runSchedulerTick(client);

        expect(mockGuildClaim).not.toHaveBeenCalled();
    });

    test('the refire guard is under 24h so a late catch-up cannot push the schedule back for good', () => {
        expect(REFIRE_GUARD_MS).toBeLessThan(24 * 60 * 60 * 1000);
    });
});
