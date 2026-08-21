'use strict';

// checkRssFeeds used to fetch every feed of every guild strictly serially —
// worst case ~40s per feed through safeFetchFeed's redirect budget — with no
// dedup when many guilds subscribe to the same URL and no skip for feeds that
// were already known dead. These tests pin the sweep that replaced it: one
// fetch per unique URL fanned out to every subscription, a bounded worker
// pool, and the shared dead-feed bookkeeping.

const mockFetches = []; // urls handed to safeFetchFeed, in call order
let mockConcurrent = 0;
let mockMaxConcurrent = 0;
let mockFeedBodies = new Map(); // url -> xml string or Error

jest.mock('../src/utils/safeFeedFetch', () => ({
    safeFetchFeed: jest.fn(async url => {
        mockFetches.push(url);
        mockConcurrent++;
        mockMaxConcurrent = Math.max(mockMaxConcurrent, mockConcurrent);
        // Yield so other workers can start before this fetch resolves —
        // otherwise every fetch completes synchronously and concurrency
        // never rises above 1 no matter what the pool does.
        await new Promise(resolve => setImmediate(resolve));
        mockConcurrent--;
        const body = mockFeedBodies.get(url);
        if (body instanceof Error) throw body;
        if (body === undefined) throw new Error(`no fixture for ${url}`);
        return body;
    }),
}));

let mockGuilds = [];
jest.mock('../src/models/Guild', () => ({
    find: jest.fn(() => ({ lean: async () => mockGuilds })),
    updateOne: jest.fn(async () => ({})),
    findOne: jest.fn(),
}));

const Guild = require('../src/models/Guild');
const { checkRssFeeds, __test__ } = require('../src/services/rssService');
const { feedFailCounts, feedLastFailTime, DEAD_FEED_THRESHOLD, RSS_FETCH_CONCURRENCY } = __test__;

function rssXml({ title = 'Feed', itemTitle = 'Post', link = 'https://example.com/post', pubDate = 'Wed, 20 Aug 2025 12:00:00 GMT' } = {}) {
    return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>${title}</title>
<item><title>${itemTitle}</title><link>${link}</link><pubDate>${pubDate}</pubDate></item>
</channel></rss>`;
}

function makeClient() {
    const send = jest.fn(async () => ({}));
    const channel = { send, isTextBased: () => true };
    return {
        channels: { fetch: jest.fn(async () => channel), cache: new Map() },
        send,
    };
}

beforeEach(() => {
    mockFetches.length = 0;
    mockConcurrent = 0;
    mockMaxConcurrent = 0;
    mockFeedBodies = new Map();
    mockGuilds = [];
    feedFailCounts.clear();
    feedLastFailTime.clear();
    Guild.updateOne.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('a URL shared by many guilds is fetched once and delivered to each', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [
        { guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] },
        { guildId: 'g2', rssFeeds: [{ _id: 'f2', url, channelId: 'c2', lastPublished: null }] },
        { guildId: 'g3', rssFeeds: [{ _id: 'f3', url, channelId: 'c3', lastPublished: null }] },
    ];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(mockFetches).toEqual([url]);
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(Guild.updateOne).toHaveBeenCalledTimes(3);
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g2', 'rssFeeds._id': 'f2' },
        { $set: { 'rssFeeds.$.lastPublished': expect.any(Date) } }
    );
});

test('fetches run in parallel but never more than the pool size at once', async () => {
    mockGuilds = Array.from({ length: 20 }, (_, i) => {
        const url = `https://example.com/rss${i}`;
        mockFeedBodies.set(url, rssXml({ link: `https://example.com/p${i}` }));
        return { guildId: `g${i}`, rssFeeds: [{ _id: `f${i}`, url, channelId: `c${i}`, lastPublished: null }] };
    });

    await checkRssFeeds(makeClient());

    expect(mockFetches).toHaveLength(20);
    expect(mockMaxConcurrent).toBeGreaterThan(1);
    expect(mockMaxConcurrent).toBeLessThanOrEqual(RSS_FETCH_CONCURRENCY);
});

test('an item no newer than lastPublished sends and writes nothing', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml({ pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' }));
    mockGuilds = [{
        guildId: 'g1',
        rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-21T00:00:00Z') }],
    }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});

test('an unparseable pubDate on a cursored feed skips rather than posting', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml({ pubDate: 'not a date' }));
    mockGuilds = [{
        guildId: 'g1',
        rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-01T00:00:00Z') }],
    }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});

test('a feed that keeps failing is marked dead and skipped on the next sweep', async () => {
    const url = 'https://dead.example.com/rss';
    mockFeedBodies.set(url, new Error('connection refused'));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();

    for (let i = 0; i < DEAD_FEED_THRESHOLD; i++) await checkRssFeeds(client);
    expect(mockFetches).toHaveLength(DEAD_FEED_THRESHOLD);

    await checkRssFeeds(client);
    expect(mockFetches).toHaveLength(DEAD_FEED_THRESHOLD); // not fetched again
});

test('one guild whose delivery blows up does not stop the fan-out to the rest', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [
        { guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] },
        { guildId: 'g2', rssFeeds: [{ _id: 'f2', url, channelId: 'c2', lastPublished: null }] },
    ];
    const client = makeClient();
    client.send.mockRejectedValueOnce(new Error('Missing Access'));

    await checkRssFeeds(client);

    // g1's send failed, but g2 was still delivered and cursored.
    expect(Guild.updateOne).toHaveBeenCalledTimes(1);
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g2', 'rssFeeds._id': 'f2' },
        { $set: { 'rssFeeds.$.lastPublished': expect.any(Date) } }
    );
});
