'use strict';

// The embed for a feed item used to be built straight from what the feed said.
// discord.js validates at build time — a title past 256 characters, a relative
// or non-http link, or a feed logo that is not a URL all throw — and the throw
// landed inside the delivery loop, before the cursor moved. The same item was
// retried on every sweep for good and nothing the feed published after it was
// ever posted; a bad logo did the same to every item. These tests pin the
// sanitising builder and the skip that backs it up.

let mockFeedBodies = new Map();
jest.mock('../src/utils/safeFeedFetch', () => ({
    safeFetchFeed: jest.fn(async url => {
        const body = mockFeedBodies.get(url);
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
const { checkRssFeeds, sendDailyNews, __test__ } = require('../src/services/rssService');
const { buildItemEmbed, EMBED_TITLE_LIMIT, feedFailCounts, feedLastFailTime } = __test__;

const FEED_URL = 'https://example.com/feed.xml';
const DATE = new Date('2025-08-20T12:00:00Z');

function makeClient() {
    const send = jest.fn(async () => ({}));
    const channel = { send, isTextBased: () => true };
    return { channels: { fetch: jest.fn(async () => channel), cache: new Map() }, send };
}

function rss({ items, image = '', link = 'https://example.com/' }) {
    return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title><link>${link}</link>${image}
${items.map(i => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate></item>`).join('\n')}
</channel></rss>`;
}

beforeEach(() => {
    mockFeedBodies = new Map();
    mockGuilds = [];
    feedFailCounts.clear();
    feedLastFailTime.clear();
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('buildItemEmbed', () => {
    const feed = { link: 'https://example.com/blog/' };

    test('truncates a title past the embed limit instead of throwing', () => {
        const embed = buildItemEmbed({ title: 'x'.repeat(400), link: 'https://example.com/a' }, DATE, feed, FEED_URL);
        expect(embed.data.title).toHaveLength(EMBED_TITLE_LIMIT);
        expect(embed.data.title.endsWith('…')).toBe(true);
    });

    test('resolves a relative link against the feed\'s site', () => {
        const embed = buildItemEmbed({ title: 'A', link: '/2025/08/post' }, DATE, feed, FEED_URL);
        expect(embed.data.url).toBe('https://example.com/2025/08/post');
    });

    test('falls back to the feed URL when the feed has no usable <link>', () => {
        const embed = buildItemEmbed({ title: 'A', link: 'post.html' }, DATE, { link: 'not a url' }, FEED_URL);
        expect(embed.data.url).toBe('https://example.com/post.html');
    });

    test('leaves off a link that is not http(s)', () => {
        const embed = buildItemEmbed({ title: 'A', link: 'javascript:alert(1)' }, DATE, feed, FEED_URL);
        expect(embed.data.url).toBeUndefined();
    });

    test('drops a feed logo that is not a URL rather than failing the item', () => {
        const embed = buildItemEmbed({ title: 'A', link: 'https://example.com/a' }, DATE, { ...feed, image: { url: 'data:,oops' } }, FEED_URL);
        expect(embed.data.thumbnail).toBeUndefined();
    });

    test('reads a title rss-parser handed back as an object', () => {
        const embed = buildItemEmbed({ title: { _: ' Hello ', $: { type: 'html' } } }, DATE, feed, FEED_URL);
        expect(embed.data.title).toBe('Hello');
    });
});

describe('the sweep with items the builder used to reject', () => {
    const cursored = lastPublished => [{ guildId: 'g1', rssFeeds: [{ _id: 'f1', url: FEED_URL, channelId: 'c1', lastPublished }] }];

    test('an over-long title posts, and the cursor moves past it', async () => {
        mockFeedBodies.set(FEED_URL, rss({ items: [
            { title: 'y'.repeat(300), link: '/long', pubDate: 'Tue, 19 Aug 2025 12:00:00 GMT' },
            { title: 'After', link: '/after', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' },
        ] }));
        mockGuilds = cursored(new Date('2025-08-18T00:00:00Z'));
        const client = makeClient();

        await checkRssFeeds(client);

        expect(client.send).toHaveBeenCalledTimes(2);
        expect(client.send.mock.calls[1][0].embeds[0].data.url).toBe('https://example.com/after');
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'g1', 'rssFeeds._id': 'f1' },
            { $set: expect.objectContaining({ 'rssFeeds.$.lastPublished': new Date('2025-08-20T12:00:00Z') }) }
        );
    });

    test('a malformed feed logo no longer stops every item', async () => {
        mockFeedBodies.set(FEED_URL, rss({
            image: '<image><url>not a url</url></image>',
            items: [{ title: 'A', link: 'https://example.com/a', pubDate: 'Wed, 20 Aug 2025 12:00:00 GMT' }],
        }));
        mockGuilds = cursored(null);
        const client = makeClient();

        await checkRssFeeds(client);

        expect(client.send).toHaveBeenCalledTimes(1);
        expect(Guild.updateOne).toHaveBeenCalledTimes(1);
    });
});

describe('the daily digest', () => {
    test('escapes Markdown in headlines and links only to absolute URLs', async () => {
        const recent = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
        mockFeedBodies.set(FEED_URL, rss({ items: [
            { title: 'Rust [1.90] *released*', link: '/rust_(lang)', pubDate: recent },
            { title: 'No link', link: 'javascript:void(0)', pubDate: recent },
        ] }));
        Guild.findOne.mockResolvedValue({
            guildId: 'g1',
            dailyNewsProfiles: [{ profileId: 'p1', enabled: true, channelId: 'c1', title: 'Digest', feeds: [FEED_URL], sentLinks: [] }],
            save: jest.fn(async () => {}),
        });
        const client = makeClient();

        await sendDailyNews(client, 'g1', 'p1');

        const description = client.send.mock.calls[0][0].embeds[0].data.description;
        expect(description).toContain('[Rust \\[1.90\\] \\*released\\*](https://example.com/rust_%28lang%29)');
        expect(description).toContain('**2. No link**');
    });
});
