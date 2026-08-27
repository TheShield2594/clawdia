'use strict';

// Daily news scheduling survives restarts (#824). The digests used to be
// in-memory node-cron jobs created at startup: the process being down — or
// restarting — at the configured minute silently cost the day's send, and a
// dashboard edit needed an explicit reschedule hook. The scheduler is now a
// minute tick over persisted state: due once the configured local time has
// passed and lastSentAt is stale, claimed atomically before sending.

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../src/utils/jobRunner', () => ({
    runJob: (service, name, fn) => fn()
}));

const mockFind = jest.fn(() => ({ lean: () => Promise.resolve([]) }));
const mockFindOne = jest.fn(async () => null);
const mockUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
jest.mock('../src/models/Guild', () => ({
    find: (...args) => mockFind(...args),
    findOne: (...args) => mockFindOne(...args),
    updateOne: (...args) => mockUpdateOne(...args)
}));

const { __test__ } = require('../src/services/rssService');
const { dailyNewsDue, runDueDailyNews, DAILY_NEWS_REFIRE_GUARD_MS } = __test__;

// sendDailyNews finds no guild document and returns early — these tests are
// about whether the slot is claimed, not what the send posts.
const client = {};

const NOW = new Date('2026-08-27T12:30:00Z');
const hoursAgo = h => new Date(NOW.getTime() - h * 60 * 60 * 1000);

beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.clearAllMocks();
    mockFind.mockImplementation(() => ({ lean: () => Promise.resolve([]) }));
    mockFindOne.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

afterEach(() => jest.useRealTimers());

describe('dailyNewsDue', () => {
    const profile = (over = {}) => ({
        profileId: 'p1', time: '09:00', timezone: 'UTC', lastSentAt: null, ...over
    });

    test('due any time after the configured minute, not only on it', () => {
        expect(dailyNewsDue(profile(), NOW)).toBe(true);
        expect(dailyNewsDue(profile({ time: '12:30' }), NOW)).toBe(true);
        expect(dailyNewsDue(profile({ time: '12:31' }), NOW)).toBe(false);
        expect(dailyNewsDue(profile({ time: '15:00' }), NOW)).toBe(false);
    });

    test('a recent send holds the slot until tomorrow', () => {
        expect(dailyNewsDue(profile({ lastSentAt: hoursAgo(2) }), NOW)).toBe(false);
        expect(dailyNewsDue(profile({ lastSentAt: hoursAgo(24) }), NOW)).toBe(true);
    });

    test('the refire guard is under 24h so a late catch-up cannot drift the schedule for good', () => {
        expect(DAILY_NEWS_REFIRE_GUARD_MS).toBeLessThan(24 * 60 * 60 * 1000);
    });

    test('a malformed time falls back to 09:00 instead of never firing', () => {
        expect(dailyNewsDue(profile({ time: 'bogus' }), NOW)).toBe(true);
    });
});

describe('runDueDailyNews', () => {
    test('claims a due profile atomically before sending', async () => {
        mockFind.mockImplementation(() => ({
            lean: () => Promise.resolve([{
                guildId: 'g1',
                dailyNewsProfiles: [{
                    profileId: 'p1', enabled: true, feeds: ['https://example.com/rss'],
                    time: '09:00', timezone: 'UTC', lastSentAt: hoursAgo(24)
                }]
            }])
        }));

        await runDueDailyNews(client);

        expect(mockUpdateOne).toHaveBeenCalledWith(
            {
                guildId: 'g1',
                dailyNewsProfiles: {
                    $elemMatch: expect.objectContaining({ profileId: 'p1', enabled: true })
                }
            },
            { $set: { 'dailyNewsProfiles.$.lastSentAt': NOW } }
        );
        // The claim succeeded, so the send went ahead (and looked the guild up).
        expect(mockFindOne).toHaveBeenCalled();
    });

    test('a lost claim race does not send', async () => {
        mockFind.mockImplementation(() => ({
            lean: () => Promise.resolve([{
                guildId: 'g1',
                dailyNewsProfiles: [{
                    profileId: 'p1', enabled: true, feeds: ['https://example.com/rss'],
                    time: '09:00', timezone: 'UTC', lastSentAt: null
                }]
            }])
        }));
        mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });

        await runDueDailyNews(client);

        expect(mockFindOne).not.toHaveBeenCalled();
    });

    test('a legacy single-profile guild claims through dailyNews.lastSentAt', async () => {
        mockFind.mockImplementation(() => ({
            lean: () => Promise.resolve([{
                guildId: 'g1',
                dailyNewsProfiles: [],
                // time 00:00 is due in every timezone, which keeps this test
                // independent of the machine the suite runs on — the legacy
                // profile is pinned to the runtime's zone.
                dailyNews: { enabled: true, feeds: ['https://example.com/rss'], time: '00:00', lastSentAt: null }
            }])
        }));

        await runDueDailyNews(client);

        expect(mockUpdateOne).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: 'g1', 'dailyNews.enabled': true }),
            { $set: { 'dailyNews.lastSentAt': NOW } }
        );
    });

    test('a profile that is not due yet is not claimed', async () => {
        mockFind.mockImplementation(() => ({
            lean: () => Promise.resolve([{
                guildId: 'g1',
                dailyNewsProfiles: [{
                    profileId: 'p1', enabled: true, feeds: ['https://example.com/rss'],
                    time: '23:59', timezone: 'UTC', lastSentAt: null
                }]
            }])
        }));

        await runDueDailyNews(client);

        expect(mockUpdateOne).not.toHaveBeenCalled();
    });
});
