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

let mockValidators = new Map(); // url -> validators the fixture answers with
let mockUnchanged = new Set();  // urls that answer 304 when asked conditionally
const mockConditionalCalls = []; // [url, validators sent]
jest.mock('../src/utils/safeFeedFetch', () => {
    const safeFetchFeed = jest.fn(async url => {
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
    });
    return {
        safeFetchFeed,
        fetchFeedConditional: jest.fn(async (url, validators) => {
            mockConditionalCalls.push([url, validators]);
            if (validators && mockUnchanged.has(url)) {
                mockFetches.push(url);
                return { notModified: true };
            }
            return { body: await safeFetchFeed(url), validators: mockValidators.get(url) || null };
        }),
    };
});

let mockGuilds = [];
jest.mock('../src/models/Guild', () => ({
    find: jest.fn(() => ({ lean: async () => mockGuilds })),
    updateOne: jest.fn(async () => ({})),
    findOne: jest.fn(),
}));

const Guild = require('../src/models/Guild');
const { checkRssFeeds, __test__ } = require('../src/services/rssService');
const { feedFailCounts, feedLastFailTime, feedValidators, DEAD_FEED_THRESHOLD, RSS_FETCH_CONCURRENCY, MAX_ITEMS_PER_SWEEP, itemKey, SEEN_IDS_MIN } = __test__;

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
    mockValidators = new Map();
    mockUnchanged = new Set();
    mockConditionalCalls.length = 0;
    feedValidators.clear();
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
        { $set: expect.objectContaining({ 'rssFeeds.$.lastPublished': expect.any(Date) }) }
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

test('an item no newer than lastPublished sends nothing and leaves the date alone', async () => {
    // A subscription from before item keys: judged by date this once, and the
    // feed's current keys recorded so keys decide from the next sweep on.
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml({ pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' }));
    mockGuilds = [{
        guildId: 'g1',
        rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-21T00:00:00Z') }],
    }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g1', 'rssFeeds._id': 'f1' },
        { $set: expect.objectContaining({ 'rssFeeds.$.seenIds': [itemKey({ link: 'https://example.com/post' })] }) }
    );
});

test('an unparseable pubDate on a subscription from before item keys is recorded, not posted', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml({ pubDate: 'not a date' }));
    mockGuilds = [{
        guildId: 'g1',
        rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-01T00:00:00Z') }],
    }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne.mock.calls[0][1].$set).not.toHaveProperty(['rssFeeds.$.lastPublished']);
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

    // g1's send failed, but g2 was still delivered and cursored. g1 records
    // only that it has been looked at — its one item is still owed.
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g1', 'rssFeeds._id': 'f1' },
        { $set: expect.objectContaining({ 'rssFeeds.$.seenIds': [] }) }
    );
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g2', 'rssFeeds._id': 'f2' },
        { $set: expect.objectContaining({ 'rssFeeds.$.lastPublished': expect.any(Date) }) }
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
        { $set: expect.objectContaining({ 'rssFeeds.$.lastPublished': new Date('2025-08-20T12:00:00Z') }) }
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
        { $set: expect.objectContaining({ 'rssFeeds.$.lastPublished': new Date(Date.UTC(2025, 7, 20, items.length - 1)) }) }
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

test('a feed with no usable dates at all still posts, going by item keys', async () => {
    // It used to post nothing, ever: the date was the only test of "new".
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'Undated', link: 'https://example.com/undated', pubDate: null },
    ]));
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();

    await checkRssFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].embeds[0].data.timestamp).toBeUndefined();
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g1', 'rssFeeds._id': 'f1' },
        { $set: expect.objectContaining({ 'rssFeeds.$.seenIds': [itemKey({ link: 'https://example.com/undated' })] }) }
    );
});


// ── What the cursor is allowed to skip ──────────────────────────────────────
//
// Batching made partial delivery possible for the first time: before it, one
// item was posted or none was, so "sent" and "cursored" could not disagree.

test('a batch that fails half way cursors to the last item that landed', async () => {
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXmlItems([
        { title: 'A', link: 'https://example.com/a', pubDate: 'Mon, 18 Aug 2025 12:00:00 GMT' },
        { title: 'B', link: 'https://example.com/b', pubDate: 'Tue, 19 Aug 2025 12:00:00 GMT' },
        { title: 'C', link: 'https://example.com/c', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
    ]));
    mockGuilds = [{
        guildId: 'g1',
        rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: new Date('2025-08-17T00:00:00Z') }],
    }];
    const client = makeClient();
    client.send
        .mockResolvedValueOnce({})                            // A lands
        .mockRejectedValueOnce(new Error('rate limited'));    // B does not

    await checkRssFeeds(client);

    // A must not be reposted next sweep, and B must not be skipped.
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(Guild.updateOne).toHaveBeenCalledTimes(1);
    expect(Guild.updateOne).toHaveBeenCalledWith(
        { guildId: 'g1', 'rssFeeds._id': 'f1' },
        { $set: expect.objectContaining({ 'rssFeeds.$.lastPublished': new Date('2025-08-18T12:00:00Z') }) }
    );
});

test('an unreachable channel leaves the cursor alone rather than dropping the burst', async () => {
    // channels.fetch throwing with nothing cached looks identical to a deleted
    // channel, so advancing here would lose the items for good on a blip.
    const url = 'https://example.com/rss';
    mockFeedBodies.set(url, rssXml());
    mockGuilds = [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];
    const client = makeClient();
    client.channels.fetch.mockRejectedValue(new Error('500 internal server error'));

    await checkRssFeeds(client);

    expect(client.send).not.toHaveBeenCalled();
    expect(Guild.updateOne).not.toHaveBeenCalled();
});

test('a sweep with no configured feeds still reports itself', async () => {
    // Otherwise "no guild has a feed" and "the job never ran" read the same
    // from the log, which is the gap the summary line exists to close.
    mockGuilds = [];
    const log = jest.spyOn(console, 'log');

    await checkRssFeeds(makeClient());

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[RSS] Sweep: 0 feed(s)'));
});


// ── Item keys ───────────────────────────────────────────────────────────────
//
// The cursor date used to be the only test of "new". Each of these is a feed
// that date alone got wrong: a lost post, a missed post, or a repost.

describe('with item keys recorded', () => {
    const url = 'https://example.com/rss';
    const key = link => itemKey({ link });
    const keyed = (seenIds, lastPublished = new Date('2025-08-20T12:00:00Z')) =>
        [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished, seenIds, title: 'Feed' }] }];
    const titles = client => client.send.mock.calls.map(c => c[0].embeds[0].data.title);

    test('a second post sharing the cursor\'s timestamp is not lost', async () => {
        mockFeedBodies.set(url, rssXmlItems([
            { title: 'First', link: 'https://example.com/1', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
            { title: 'Twin', link: 'https://example.com/2', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
        ]));
        mockGuilds = keyed([key('https://example.com/1')]);
        const client = makeClient();

        await checkRssFeeds(client);

        expect(titles(client)).toEqual(['Twin']);
    });

    test('a post back-dated a few hours behind the cursor is still posted', async () => {
        mockFeedBodies.set(url, rssXmlItems([
            { title: 'Seen', link: 'https://example.com/1', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
            { title: 'Scheduled', link: 'https://example.com/2', pubDate: 'Wed, 20 Aug 2025 06:00:00 GMT' },
        ]));
        mockGuilds = keyed([key('https://example.com/1')]);
        const client = makeClient();

        await checkRssFeeds(client);

        expect(titles(client)).toEqual(['Scheduled']);
        // The date only moves forward.
        expect(Guild.updateOne.mock.calls[0][1].$set).not.toHaveProperty(['rssFeeds.$.lastPublished']);
    });

    test('unseen items far older than the cursor are recorded, not posted', async () => {
        // What a feed changing its guid scheme looks like: its whole archive
        // is suddenly "unseen".
        mockFeedBodies.set(url, rssXmlItems([
            { title: 'Archive', link: 'https://example.com/old', pubDate: 'Mon, 11 Aug 2025 12:00:00 GMT' },
        ]));
        mockGuilds = keyed([]);
        const client = makeClient();

        await checkRssFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'g1', 'rssFeeds._id': 'f1' },
            { $set: { 'rssFeeds.$.seenIds': [key('https://example.com/old')] } }
        );
    });

    test('an old post re-dated by an edit is not posted again', async () => {
        mockFeedBodies.set(url, rssXmlItems([
            { title: 'Edited', link: 'https://example.com/1', pubDate: 'Fri, 22 Aug 2025 12:00:00 GMT' },
        ]));
        mockGuilds = keyed([key('https://example.com/1')]);
        const client = makeClient();

        await checkRssFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('a guid wins over the link as the item\'s identity', async () => {
        mockFeedBodies.set(url, `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
<item><title>Moved</title><link>https://example.com/new-slug</link><guid isPermaLink="false">post-42</guid><pubDate>Thu, 21 Aug 2025 12:00:00 GMT</pubDate></item>
</channel></rss>`);
        mockGuilds = keyed([itemKey({ guid: 'post-42' })]);
        const client = makeClient();

        await checkRssFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
    });

    test('an item whose send failed is still owed on the next sweep', async () => {
        mockFeedBodies.set(url, rssXmlItems([
            { title: 'New', link: 'https://example.com/2', pubDate: 'Thu, 21 Aug 2025 12:00:00 GMT' },
        ]));
        mockGuilds = keyed([]);
        const client = makeClient();
        client.send.mockRejectedValueOnce(new Error('rate limited'));

        await checkRssFeeds(client);

        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('the recorded keys are bounded but always cover the whole feed', async () => {
        const items = Array.from({ length: SEEN_IDS_MIN + 50 }, (_, i) => ({
            title: `i${i}`, link: `https://example.com/${i}`, pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT',
        }));
        mockFeedBodies.set(url, rssXmlItems(items));
        const history = Array.from({ length: SEEN_IDS_MIN }, (_, i) => `old-${i}`);
        mockGuilds = keyed(history.concat(items.slice(1).map(i => key(i.link))));

        await checkRssFeeds(makeClient());

        const seen = Guild.updateOne.mock.calls[0][1].$set['rssFeeds.$.seenIds'];
        expect(seen).toHaveLength(items.length);
        expect(seen).toContain(key(items[0].link));
    });
});


// ── Conditional requests ────────────────────────────────────────────────────
//
// Every feed used to be downloaded and parsed in full every five minutes,
// changed or not.

describe('conditional fetches', () => {
    const url = 'https://example.com/rss';
    const validators = { etag: '"v1"', lastModified: null };
    const subscribed = () => [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null }] }];

    beforeEach(() => {
        mockFeedBodies.set(url, rssXml());
        mockValidators.set(url, validators);
        mockUnchanged.add(url);
    });

    test('the next sweep sends back the validators the feed answered with', async () => {
        mockGuilds = subscribed();
        const client = makeClient();

        await checkRssFeeds(client);
        await checkRssFeeds(client);

        expect(mockConditionalCalls.map(c => c[1])).toEqual([undefined, validators]);
    });

    test('a feed that answers 304 is not delivered, and counts as unchanged', async () => {
        mockGuilds = subscribed();
        const client = makeClient();
        await checkRssFeeds(client);
        client.send.mockClear();
        Guild.updateOne.mockClear();
        const log = jest.spyOn(console, 'log');

        await checkRssFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
        expect(Guild.updateOne).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('1 unchanged'));
    });

    test('an item still owed to a channel keeps the next fetch unconditional', async () => {
        // A 304 skips delivery, so holding validators here would leave the
        // item waiting until the feed next changed.
        mockGuilds = subscribed();
        const client = makeClient();
        client.send.mockRejectedValueOnce(new Error('rate limited'));

        await checkRssFeeds(client);
        await checkRssFeeds(client);

        expect(mockConditionalCalls.map(c => c[1])).toEqual([undefined, undefined]);
        expect(client.send).toHaveBeenCalledTimes(2);
    });

    test('an unreachable channel keeps the next fetch unconditional too', async () => {
        mockGuilds = subscribed();
        const client = makeClient();
        client.channels.fetch.mockRejectedValueOnce(new Error('500'));

        await checkRssFeeds(client);

        expect(feedValidators.has(url)).toBe(false);
    });

    test('a failed fetch forgets the validators', async () => {
        mockGuilds = subscribed();
        await checkRssFeeds(makeClient());
        expect(feedValidators.has(url)).toBe(true);

        mockUnchanged.clear();
        mockFeedBodies.set(url, new Error('HTTP 500'));
        await checkRssFeeds(makeClient());

        expect(feedValidators.has(url)).toBe(false);
    });

    test('validators for a URL nothing subscribes to any more are dropped', async () => {
        mockGuilds = subscribed();
        await checkRssFeeds(makeClient());
        expect(feedValidators.has(url)).toBe(true);

        mockGuilds = [];
        await checkRssFeeds(makeClient());

        expect(feedValidators.size).toBe(0);
    });
});


// ── Feed health on the subscription ─────────────────────────────────────────
//
// A feed that stopped working used to say so only in the bot's console. The
// sweep now records it where the dashboard reads it.

describe('feed health', () => {
    const url = 'https://example.com/rss';
    const sub = extra => [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url, channelId: 'c1', lastPublished: null, title: 'Feed', ...extra }] }];

    test('a failed fetch records the error and when the failure began', async () => {
        mockFeedBodies.set(url, new Error('Feed request failed with HTTP 404.'));
        mockGuilds = sub();

        await checkRssFeeds(makeClient());

        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'g1', 'rssFeeds._id': 'f1' },
            { $set: { 'rssFeeds.$.lastError': 'Feed request failed with HTTP 404.', 'rssFeeds.$.failingSince': expect.any(Date) } }
        );
    });

    test('the same error again writes nothing', async () => {
        mockFeedBodies.set(url, new Error('Feed request failed with HTTP 404.'));
        mockGuilds = sub({ lastError: 'Feed request failed with HTTP 404.', failingSince: new Date('2026-09-01T00:00:00Z') });

        await checkRssFeeds(makeClient());

        expect(Guild.updateOne).not.toHaveBeenCalled();
    });

    test('a different error updates the message but keeps when the failure began', async () => {
        mockFeedBodies.set(url, new Error('Feed request failed with HTTP 500.'));
        mockGuilds = sub({ lastError: 'Feed request failed with HTTP 404.', failingSince: new Date('2026-09-01T00:00:00Z') });

        await checkRssFeeds(makeClient());

        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'g1', 'rssFeeds._id': 'f1' },
            { $set: { 'rssFeeds.$.lastError': 'Feed request failed with HTTP 500.' } }
        );
    });

    test('the next good fetch clears the failure, even with nothing new to post', async () => {
        mockFeedBodies.set(url, rssXml());
        mockGuilds = [{ guildId: 'g1', rssFeeds: [{
            _id: 'f1', url, channelId: 'c1', title: 'Feed', lastPublished: new Date('2025-08-21T00:00:00Z'),
            seenIds: [itemKey({ link: 'https://example.com/post' })],
            lastError: 'Feed request failed with HTTP 404.', failingSince: new Date('2026-09-01T00:00:00Z'),
        }] }];
        const client = makeClient();

        await checkRssFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'g1', 'rssFeeds._id': 'f1' },
            { $set: { 'rssFeeds.$.lastError': null, 'rssFeeds.$.failingSince': null } }
        );
    });

    test('a post records when it happened, and the feed\'s name is kept current', async () => {
        mockFeedBodies.set(url, rssXml({ title: 'Renamed Feed' }));
        mockGuilds = sub();

        await checkRssFeeds(makeClient());

        const $set = Guild.updateOne.mock.calls[0][1].$set;
        expect($set['rssFeeds.$.lastPostedAt']).toEqual(expect.any(Date));
        expect($set['rssFeeds.$.title']).toBe('Renamed Feed');
    });
});
