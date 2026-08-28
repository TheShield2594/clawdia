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
const { feedFailCounts, feedLastFailTime, DEAD_FEED_THRESHOLD, RSS_FETCH_CONCURRENCY, MAX_ITEMS_PER_SWEEP } = __test__;

function rssXml({ title = 'Feed', itemTitle = 'Post', link = 'https://example.com/post', pubDate = 'Wed, 20 Aug 2025 12:00:00 GMT' } = {}) {
    return rssXmlItems([{ title: itemTitle, link, pubDate }], title);
}

// `items` in document order, so a test can put the newest last (as plenty of
// real feeds do) and assert the sweep does not trust that order.
function rssXmlItems(items, title = 'Feed') {
    const body = items.map(i =>
        `<item><title>${i.title}</title><link>${i.link}</link>` +
        (i.pubDate === null ? '' : `<pubDate>${i.pubDate}</pubDate>`) +
        '</item>'
    ).join('\n');
    return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>${title}</title>
${body}
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


// ── What the cursor is read from ────────────────────────────────────────────
//
// The sweep used to take `items[0]` as "the latest item" and its pubDate as the
// cursor. Nothing in RSS or Atom orders a feed, an unparseable date is not a
// timestamp an embed can carry, and a feed can publish more than once between
// two five-minute sweeps. Each of those is a way a feed went quiet with nothing
// in the log to say so.

test('a feed listed oldest-first posts its newest item, not its first', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'Older', link: 'https://example.com/old', pubDate: 'Mon, 18 Aug 2025 12:00:00 GMT' },
        { title: 'Newest', link: 'https://example.com/new', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
    ]));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].embeds[0].data.title).toBe('Newest');
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g1', 'rssFeeds._id': 'f1' },
        { $set: { 'rssFeeds.$.lastPublished': new Date('2025-08-20T12:00:00Z') } }
    );
});

test('a first sight of a feed posts one item, not its whole archive', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'A', link: 'https://example.com/a', pubDate: 'Mon, 18 Aug 2025 12:00:00 GMT' },
        { title: 'B', link: 'https://example.com/b', pubDate: 'Tue, 19 Aug 2025 12:00:00 GMT' },
        { title: 'C', link: 'https://example.com/c', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
    ]));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].embeds[0].data.title).toBe('C');
});

test('every item published since the last sweep is posted, oldest first', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'C', link: 'https://example.com/c', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
        { title: 'B', link: 'https://example.com/b', pubDate: 'Tue, 19 Aug 2025 12:00:00 GMT' },
        { title: 'A', link: 'https://example.com/a', pubDate: 'Mon, 18 Aug 2025 12:00:00 GMT' },
    ]));
    mockGuilds = [{
        guildId: 'g1',
        rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-18T18:00:00Z') }],
    }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send.mock.calls.map(c => c[0].embeds[0].data.title)).toEqual(['B', 'C']);
});

test('a burst larger than the per-sweep cap posts the newest and cursors past the rest', async () => {
    const url = 'https://example.com/rss';
    const items = Array.from({ length: MAX_ITEMS_PER_SWEEP + 3 }, (_, i) => ({
        title: `item${i}`,
        link: `https://example.com/${i}`,
        pubDate: new Date(Date.UTC(2025, 7, 20, i)).toUTCString(),
    }));
    mockFeedBodies.set(url, rssXmlItems(items));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-19T00:00:00Z') }] }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(MAX_ITEMS_PER_SWEEP);
    const titles = client.send.mock.calls.map(c => c[0].embeds[0].data.title);
    expect(titles[titles.length - 1]).toBe(`item${items.length - 1}`);
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g1', 'rssFeeds._id': 'f1' },
        { $set: { 'rssFeeds.$.lastPublished': new Date(Date.UTC(2025, 7, 20, items.length - 1)) } }
    );
});

test('an unparseable pubDate on a fresh feed is skipped, not retried forever', async () => {
    // setTimestamp(new Date('not a date')) throws RangeError, which aborted the
    // delivery before the cursor was written — so the same feed threw again on
    // every sweep and never posted anything.
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'Undated', link: 'https://example.com/undated', pubDate: 'not a date' },
        { title: 'Dated', link: 'https://example.com/dated', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
    ]));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].embeds[0].data.title).toBe('Dated');
    expect(Guild.updateOne).toHaveBeenCalledTimes(1);
});

test('a feed with no usable dates at all posts nothing and raises nothing', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'Undated', link: 'https://example.com/undated', pubDate: null },
    ]));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});
