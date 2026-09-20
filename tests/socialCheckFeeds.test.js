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

// An X/Twitter-style feed as the RSSHub bridge emits it: the tweet text and any
// photo live in an HTML <description>, and <title> is empty or generic.
function xXml({ title = '', description, link = 'https://x/post', pubDate = 'Wed, 20 Aug 2025 12:00:00 GMT', feedTitle = '@NOTWOKESHOWS', feedImage, creator } = {}) {
    const image = feedImage ? `<image><url>${feedImage}</url></image>` : '';
    const author = creator ? `<dc:creator>${creator}</dc:creator>` : '';
    return `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${feedTitle}</title>${image}
<item><title>${title}</title><link>${link}</link>${author}
<description><![CDATA[${description}]]></description>
<pubDate>${pubDate}</pubDate></item>
</channel></rss>`;
}

function xFeed(id, url, channelId, lastPublished = null) {
    return { _id: id, platform: 'twitter', ref: '@NOTWOKESHOWS', feedUrl: url, channelId, lastPublished };
}

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

test('an X post shows the tweet text and photo instead of a bare "New post"', async () => {
    const url = 'https://bridge/twitter/user/NOTWOKESHOWS';
    mockFeedBodies.set(url, xXml({
        description: '<p>They cancelled the show. Absolute clown world.</p>'
            + '<img src="https://pbs.twimg.com/media/photo.jpg" />',
        feedImage: 'https://pbs.twimg.com/profile/avatar.jpg',
    }));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [xFeed('f1', url, 'c1')] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    expect(client.send).toHaveBeenCalledTimes(1);
    const embed = client.send.mock.calls[0][0].embeds[0].data;
    // The tweet body leads; there is no meaningless "New post" headline.
    expect(embed.title).toBeUndefined();
    expect(embed.description).toBe('They cancelled the show. Absolute clown world.');
    // The photo is shown large, and the profile picture badges the author.
    expect(embed.image.url).toBe('https://pbs.twimg.com/media/photo.jpg');
    expect(embed.author.icon_url).toBe('https://pbs.twimg.com/profile/avatar.jpg');
    expect(embed.author.url).toBe('https://x/post');
    // Native-style author line: the handle leads; the platform sits in the footer.
    expect(embed.author.name).toBe('@NOTWOKESHOWS');
    expect(embed.footer.text).toBe('X (Twitter)');
    expect(embed.color).toBe(0x1DA1F2);
});

test('an X post shows the poster name and handle like a native unfurl', async () => {
    const url = 'https://bridge/twitter/user/IGN';
    mockFeedBodies.set(url, xXml({
        feedTitle: 'IGN / @IGN',
        creator: 'IGN',
        description: "Zach Cregger's Resident Evil pushed through the backlash to $108.3M globally.",
    }));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [
        { _id: 'f1', platform: 'twitter', ref: '@IGN', feedUrl: url, channelId: 'c1', lastPublished: null },
    ] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    const embed = client.send.mock.calls[0][0].embeds[0].data;
    expect(embed.author.name).toBe('IGN (@IGN)');
    expect(embed.footer.text).toBe('X (Twitter)');
});

test('a text-only X post still reads as the tweet, with the avatar as thumbnail', async () => {
    const url = 'https://bridge/twitter/user/someone';
    mockFeedBodies.set(url, xXml({
        description: 'just setting up my twttr',
        feedImage: 'https://pbs.twimg.com/profile/avatar.jpg',
    }));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [xFeed('f1', url, 'c1')] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    const embed = client.send.mock.calls[0][0].embeds[0].data;
    expect(embed.title).toBeUndefined();
    expect(embed.description).toBe('just setting up my twttr');
    expect(embed.image).toBeUndefined();
    expect(embed.thumbnail.url).toBe('https://pbs.twimg.com/profile/avatar.jpg');
});

test('inline-image extraction skips srcset and reads the real src, single-quoted', async () => {
    // Guards the string-scanning src reader: "srcset" must not be mistaken for
    // "src", and single-quoted values must parse.
    const { postMedia } = __test__;
    expect(postMedia({
        content: "<img srcset='https://x/small.jpg 1x' src='https://x/real.jpg' alt='x' />",
    })).toBe('https://x/real.jpg');
    // An enclosure still wins over inline content when present.
    expect(postMedia({
        enclosure: { url: 'https://x/enclosure.jpg' },
        content: '<img src="https://x/inline.jpg" />',
    })).toBe('https://x/enclosure.jpg');
    // No usable image anywhere.
    expect(postMedia({ content: '<p>text only, no picture</p>' })).toBeNull();
    // `data-src` must not be mistaken for `src` — the real src wins.
    expect(postMedia({
        content: '<img data-src="https://cdn/placeholder.jpg" src="https://cdn/photo.jpg">',
    })).toBe('https://cdn/photo.jpg');
});

test('postAuthorName shapes the microblog author line like a native unfurl', () => {
    const { postAuthorName } = __test__;
    // Display name + handle when the feed names the poster.
    expect(postAuthorName({ ref: '@IGN' }, { creator: 'IGN' }, '@IGN')).toBe('IGN (@IGN)');
    // No duplicate when the creator is just the handle again.
    expect(postAuthorName({ ref: '@IGN' }, { creator: '@IGN' }, '@IGN')).toBe('@IGN');
    // An email-shaped <author> is not a name — fall back to the handle.
    expect(postAuthorName({ ref: '@IGN' }, { author: 'noreply@x.com' }, '@IGN')).toBe('@IGN');
    // Nothing to go on but the handle.
    expect(postAuthorName({ ref: '@someone' }, {}, '@someone')).toBe('@someone');
});

test('a TikTok post uses the caption from the item title as its body', async () => {
    // RSSHub's TikTok route maps a clip's caption to <title> and fills
    // <description> with the video-player embed, so the caption lives in title.
    const url = 'https://bridge/tiktok/user/@creator';
    mockFeedBodies.set(url, `<?xml version="1.0"?>
<rss version="2.0"><channel><title>@creator</title>
<item><title>Check out my new dance! #fyp</title><link>https://tt/v/1</link>
<description>&lt;iframe src="https://tiktok/player/1"&gt;&lt;/iframe&gt;</description>
<pubDate>Wed, 20 Aug 2025 12:00:00 GMT</pubDate></item>
</channel></rss>`);
    mockGuilds = [{ guildId: 'g1', socialFeeds: [
        { _id: 'f1', platform: 'tiktok', ref: '@creator', feedUrl: url, channelId: 'c1', lastPublished: null },
    ] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    const embed = client.send.mock.calls[0][0].embeds[0].data;
    expect(embed.description).toBe('Check out my new dance! #fyp');
    expect(embed.title).toBeUndefined();
    expect(embed.author.name).toBe('@creator');
    expect(embed.footer.text).toBe('TikTok');
});

test('a photo-only X post shows the image with no empty headline', async () => {
    const url = 'https://bridge/twitter/user/pics';
    mockFeedBodies.set(url, xXml({
        description: '<img src="https://pbs.twimg.com/media/only.jpg" />',
    }));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [xFeed('f1', url, 'c1')] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    const embed = client.send.mock.calls[0][0].embeds[0].data;
    expect(embed.title).toBeUndefined();
    expect(embed.description).toBeUndefined();
    expect(embed.image.url).toBe('https://pbs.twimg.com/media/only.jpg');
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
