'use strict';

// checkSocialFeeds is the RSS sweep applied to the socialFeeds array: one fetch
// per unique resolved URL fanned out to every subscription, a bounded worker
// pool, cursor dedup on socialFeeds._id, per-platform embed styling, and the
// shared dead-source bookkeeping. These pin the behaviours that differ from —
// and the ones that must match — the RSS sweep.

const mockFetches = [];
let mockConcurrent = 0;
let mockMaxConcurrent = 0;
let mockFeedBodies = new Map();

jest.mock('../src/utils/safeFeedFetch', () => ({
    safeFetchFeed: jest.fn(async url => {
        mockFetches.push(url);
        mockConcurrent++;
        mockMaxConcurrent = Math.max(mockMaxConcurrent, mockConcurrent);
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
const { checkSocialFeeds, __test__ } = require('../src/services/socialService');
const { feedFailCounts, feedLastFailTime, DEAD_FEED_THRESHOLD, SOCIAL_FETCH_CONCURRENCY } = __test__;

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
const rssXml = ({ title = 'Feed', itemTitle = 'Post', link = 'https://x/post', pubDate = 'Wed, 20 Aug 2025 12:00:00 GMT' } = {}) =>
    rssXmlItems([{ title: itemTitle, link, pubDate }], title);

function makeClient() {
    const send = jest.fn(async () => ({}));
    const channel = { send, isTextBased: () => true };
    return { channels: { fetch: jest.fn(async () => channel), cache: new Map() }, send };
}

// A YouTube subscription following one resolved feed URL.
function ytFeed(id, url, channelId, lastPublished = null) {
    return { _id: id, platform: 'youtube', ref: '@creator', feedUrl: url, channelId, lastPublished };
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

test('a URL followed by many guilds is fetched once and delivered to each', async () => {
    const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [
        { guildId: 'g1', socialFeeds: [ytFeed('f1', url, 'c1')] },
        { guildId: 'g2', socialFeeds: [ytFeed('f2', url, 'c2')] },
    ];
    const client = makeClient();

    await checkSocialFeeds(client);

    expect(mockFetches).toEqual([url]);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g2', 'socialFeeds._id': 'f2' },
        { $set: { 'socialFeeds.$.lastPublished': expect.any(Date) } }
    );
});

test('fetches run in parallel but never exceed the pool size', async () => {
    mockGuilds = Array.from({ length: 20 }, (_, i) => {
        const url = `https://feed/${i}`;
        mockFeedBodies.set(url, rssXml({ link: `https://x/${i}` }));
        return { guildId: `g${i}`, socialFeeds: [ytFeed(`f${i}`, url, `c${i}`)] };
    });

    await checkSocialFeeds(makeClient());

    expect(mockFetches).toHaveLength(20);
    expect(mockMaxConcurrent).toBeGreaterThan(1);
    expect(mockMaxConcurrent).toBeLessThanOrEqual(SOCIAL_FETCH_CONCURRENCY);
});

test('first sight posts one item and styles the embed for its platform', async () => {
    const url = 'https://feed/one';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'Old', link: 'https://x/old', pubDate: 'Mon, 18 Aug 2025 12:00:00 GMT' },
        { title: 'New video!', link: 'https://x/new', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
    ]));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [ytFeed('f1', url, 'c1')] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(1);
    const embed = client.send.mock.calls[0][0].embeds[0].data;
    expect(embed.title).toBe('New video!');
    expect(embed.color).toBe(0xFF0000); // YouTube red
    expect(embed.author.name).toContain('YouTube');
    expect(embed.author.name).toContain('@creator');
});

test('an item no newer than the cursor sends and writes nothing', async () => {
    const url = 'https://feed/cursored';
    mockFeedBodies.set(url, rssXml({ pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' }));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [ytFeed('f1', url, 'c1', new Date('2025-08-21T00:00:00Z'))] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});

test('a source that keeps failing is marked dead and skipped next sweep', async () => {
    const url = 'https://dead/feed';
    mockFeedBodies.set(url, new Error('connection refused'));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [ytFeed('f1', url, 'c1')] }];
    const client = makeClient();

    for (let i = 0; i < DEAD_FEED_THRESHOLD; i++) await checkSocialFeeds(client);
    expect(mockFetches).toHaveLength(DEAD_FEED_THRESHOLD);

    await checkSocialFeeds(client);
    expect(mockFetches).toHaveLength(DEAD_FEED_THRESHOLD);
});

test('one guild whose delivery blows up does not stop the fan-out', async () => {
    const url = 'https://feed/shared';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [
        { guildId: 'g1', socialFeeds: [ytFeed('f1', url, 'c1')] },
        { guildId: 'g2', socialFeeds: [ytFeed('f2', url, 'c2')] },
    ];
    const client = makeClient();
    client.send.mockRejectedValueOnce(new Error('Missing Access'));

    await checkSocialFeeds(client);

    expect(Guild.updateOne).toHaveBeenCalledTimes(1);
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g2', 'socialFeeds._id': 'f2' },
        { $set: { 'socialFeeds.$.lastPublished': expect.any(Date) } }
    );
});

test('an unreachable channel leaves the cursor alone', async () => {
    const url = 'https://feed/blip';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [{ guildId: 'g1', socialFeeds: [ytFeed('f1', url, 'c1')] }];
    const client = makeClient();
    client.channels.fetch.mockRejectedValue(new Error('500 internal server error'));

    await checkSocialFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});

test('a subscription on a platform we no longer support is skipped, not thrown', async () => {
    const url = 'https://feed/gone';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [{
        guildId: 'g1',
        socialFeeds: [{ _id: 'f1', platform: 'myspace', ref: 'x', feedUrl: url, channelId: 'c1', lastPublished: null }],
    }];
    const client = makeClient();

    await checkSocialFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});

test('a sweep with no subscriptions still reports itself', async () => {
    mockGuilds = [];
    const log = jest.spyOn(console, 'log');

    await checkSocialFeeds(makeClient());

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[Social] Sweep: 0 source(s)'));
});
