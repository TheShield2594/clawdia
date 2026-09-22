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

// ── X posts enriched through FxTwitter ─────────────────────────────────────
//
// The bridge's item links to x.com, so the sweep looks the tweet up on the
// FxTwitter API (fetched through the same mocked safeFetchFeed) and builds the
// embed from that instead of the bridge's HTML.

const X_LINK = 'https://x.com/NOTWOKESHOWS/status/1900000000000000001';
const FX_URL = 'https://api.fxtwitter.com/NOTWOKESHOWS/status/1900000000000000001';

function fxTweet(overrides = {}) {
    return {
        id: '1900000000000000001',
        url: X_LINK,
        text: 'Enjoy shows... that aren’t woke! MobLand is a crime drama series. #MobLand @paramountplus',
        created_timestamp: 1758570000,
        author: { name: 'NOT WOKE SHOWS.com', screen_name: 'NOTWOKESHOWS', avatar_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
        media: {},
        replying_to: null,
        possibly_sensitive: false,
        ...overrides,
    };
}

async function sweepEnrichedX(tweet, { nsfw = false, description = '<br><video poster=\'https://pbs.twimg.com/amplify_video_thumb/1/img/x.jpg\'></video>' } = {}) {
    require('../src/services/xEnrichment').__test__.cache.clear();
    const url = 'https://bridge/twitter/user/NOTWOKESHOWS';
    mockFeedBodies.set(url, xXml({ link: X_LINK, description, creator: 'NOT WOKE SHOWS.com' }));
    mockFeedBodies.set(FX_URL, JSON.stringify({ code: 200, message: 'OK', tweet }));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [xFeed('f1', url, 'c1')] }];
    const client = makeClient();
    if (nsfw) (await client.channels.fetch()).nsfw = true;
    await checkSocialFeeds(client);
    expect(client.send).toHaveBeenCalledTimes(1);
    return client.send.mock.calls[0][0].embeds.map(e => e.data);
}

test('an X post with several photos renders the full text and a four-image gallery', async () => {
    const photos = [1, 2, 3, 4, 5].map(n => ({ type: 'photo', url: `https://pbs.twimg.com/media/p${n}.jpg?name=orig`, width: 1, height: 1 }));
    const embeds = await sweepEnrichedX(fxTweet({ media: { all: photos } }));

    expect(mockFetches).toContain(FX_URL);
    expect(embeds).toHaveLength(4); // Discord's gallery tops out at four
    const [main, ...rest] = embeds;
    expect(main.author.name).toBe('NOT WOKE SHOWS.com (@NOTWOKESHOWS)');
    expect(main.author.icon_url).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.jpg');
    expect(main.url).toBe(X_LINK);
    expect(main.description).toContain('MobLand is a crime drama series.');
    expect(main.description).toContain('[#MobLand](https://x.com/hashtag/MobLand)');
    expect(main.description).toContain('[@paramountplus](https://x.com/paramountplus)');
    // `name=orig` is swapped for X's `large` rendition Discord can proxy.
    expect(main.image.url).toBe('https://pbs.twimg.com/media/p1.jpg?name=large');
    expect(rest.map(e => e.url)).toEqual([X_LINK, X_LINK, X_LINK]);
    expect(rest.map(e => e.image.url)).toEqual([2, 3, 4].map(n => `https://pbs.twimg.com/media/p${n}.jpg?name=large`));
    expect(main.timestamp).toBe(new Date(1758570000 * 1000).toISOString());
});

test('a video tweet shows its thumbnail and a watch link with the duration', async () => {
    const embeds = await sweepEnrichedX(fxTweet({
        text: '',
        media: { videos: [{ type: 'video', url: 'https://video.twimg.com/v.mp4', thumbnail_url: 'https://pbs.twimg.com/thumb.jpg', duration: 92, width: 1, height: 1 }] },
    }));
    expect(embeds).toHaveLength(1);
    expect(embeds[0].image.url).toBe('https://pbs.twimg.com/thumb.jpg');
    expect(embeds[0].description).toBe(`▶️ [Watch video (1:32)](${X_LINK})`);
});

test('a link-card tweet shows the card as its picture instead of the avatar', async () => {
    const embeds = await sweepEnrichedX(fxTweet({
        card: { url: 'https://www.notwokeshows.com/show/mobland-2025', title: 'MobLand [2025]', domain: 'notwokeshows.com', image: { url: 'https://pbs.twimg.com/card_img/1?format=jpg&name=orig' } },
    }));
    const main = embeds[0];
    expect(main.image.url).toBe('https://pbs.twimg.com/card_img/1?format=jpg&name=large');
    expect(main.thumbnail).toBeUndefined();
    expect(main.description).toContain('🔗 **[MobLand 2025](https://www.notwokeshows.com/show/mobland-2025)**');
    expect(main.description).toContain('-# notwokeshows.com');
});

test('a quote tweet carries the quoted post as a field and borrows its picture', async () => {
    const embeds = await sweepEnrichedX(fxTweet({
        text: 'This one is great',
        quote: {
            id: '7', url: 'https://x.com/other/status/7', text: 'Season 2 confirmed',
            author: { name: 'Other', screen_name: 'other' },
            media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/media/q.jpg', width: 1, height: 1 }] },
        },
    }));
    const main = embeds[0];
    expect(main.fields[0].name).toBe('💬 Quoting Other (@other)');
    expect(main.fields[0].value).toBe('Season 2 confirmed\n[View quoted post](https://x.com/other/status/7)');
    expect(main.image.url).toBe('https://pbs.twimg.com/media/q.jpg');
});

test('a repost and a reply say so above the text', async () => {
    const repost = await sweepEnrichedX(fxTweet({
        url: 'https://x.com/studio/status/9',
        author: { name: 'Studio', screen_name: 'studio' },
    }));
    expect(repost[0].author.name).toBe('Studio (@studio)');
    expect(repost[0].description.startsWith('-# 🔁 NOT WOKE SHOWS.com reposted')).toBe(true);

    mockFetches.length = 0;
    const reply = await sweepEnrichedX(fxTweet({ replying_to: 'someone' }));
    expect(reply[0].description.startsWith('-# ↩️ Replying to [@someone](https://x.com/someone)')).toBe(true);
});

test('sensitive media is held back outside age-restricted channels', async () => {
    const tweet = fxTweet({ possibly_sensitive: true, media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/media/s.jpg', width: 1, height: 1 }] } });
    const sfw = await sweepEnrichedX(tweet);
    expect(sfw[0].image).toBeUndefined();
    expect(sfw[0].description).toContain('Sensitive media hidden');

    const nsfw = await sweepEnrichedX(tweet, { nsfw: true });
    expect(nsfw[0].image.url).toBe('https://pbs.twimg.com/media/s.jpg');
});

test('when the X lookup fails the post still goes out from the bridge feed', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    require('../src/services/xEnrichment').__test__.cache.clear();
    const url = 'https://bridge/twitter/user/NOTWOKESHOWS';
    mockFeedBodies.set(url, xXml({
        link: X_LINK,
        // Not CDATA-escaped the way RSSHub sometimes is: the & arrives as &amp;.
        description: 'Two pics<br><img src="https://pbs.twimg.com/media/a?format=jpg&amp;name=orig">'
            + '<br><img src="https://pbs.twimg.com/media/b?format=jpg&amp;name=orig">',
    }));
    mockFeedBodies.set(FX_URL, new Error('Feed request failed with HTTP 503.'));
    mockGuilds = [{ guildId: 'g1', socialFeeds: [xFeed('f1', url, 'c1')] }];
    const client = makeClient();

    await checkSocialFeeds(client);

    const embeds = client.send.mock.calls[0][0].embeds.map(e => e.data);
    expect(embeds).toHaveLength(2);
    expect(embeds[0].description).toBe('Two pics');
    expect(embeds[0].image.url).toBe('https://pbs.twimg.com/media/a?format=jpg&name=large');
    expect(embeds[1].image.url).toBe('https://pbs.twimg.com/media/b?format=jpg&name=large');
    expect(embeds[1].url).toBe(X_LINK);
});

test('a video tweet from the bridge alone shows its poster frame', () => {
    const { postMediaList } = __test__;
    expect(postMediaList({
        content: "<br><video width=\"1\" src='https://video.twimg.com/v.mp4' controls='controls' poster='https://pbs.twimg.com/thumb.jpg'></video>",
    })).toEqual(['https://pbs.twimg.com/thumb.jpg']);
});

test('linkify leaves emails, URL paths and fragments alone', () => {
    const { linkifyTweetText } = __test__;
    expect(linkifyTweetText('mail a@b.com or medium.com/@user and site.com/#frag')).toBe('mail a@b.com or medium.com/@user and site.com/#frag');
    expect(linkifyTweetText('@jack #1 #tag')).toBe('[@jack](https://x.com/jack) #1 [#tag](https://x.com/hashtag/tag)');
});

// ── X accounts read from the FxTwitter timeline ────────────────────────────
//
// An X subscription is swept by handle: FxTwitter's timeline first, the bridge
// only if that fails. These pin the source order, the shared sweep key for old
// (bridge URL) and new (profile URL) subscriptions, and cursor continuity.

const TIMELINE_URL = 'https://api.fxtwitter.com/2/profile/NOTWOKESHOWS/statuses?count=20';

function timelineTweet(id, seconds, overrides = {}) {
    return {
        id: String(id),
        url: `https://x.com/NOTWOKESHOWS/status/${id}`,
        text: `post ${id}`,
        created_timestamp: seconds,
        author: { name: 'NOT WOKE SHOWS.com', screen_name: 'NOTWOKESHOWS', avatar_url: 'https://pbs.twimg.com/a_normal.jpg' },
        media: {},
        ...overrides,
    };
}

function timelineBody(tweets) {
    return JSON.stringify({ code: 200, results: tweets });
}

function xProfileFeed(id, channelId, lastPublished = null) {
    return { _id: id, platform: 'twitter', ref: '@NOTWOKESHOWS', feedUrl: 'https://x.com/NOTWOKESHOWS', channelId, lastPublished };
}

describe('X timeline source', () => {
    const ORIGINAL_BRIDGE = process.env.SOCIAL_BRIDGE_BASE_URL;
    beforeEach(() => require('../src/services/xEnrichment').__test__.cache.clear());
    afterEach(() => {
        if (ORIGINAL_BRIDGE === undefined) delete process.env.SOCIAL_BRIDGE_BASE_URL;
        else process.env.SOCIAL_BRIDGE_BASE_URL = ORIGINAL_BRIDGE;
    });

    test('first sight posts the newest tweet from the timeline, with no bridge and no second lookup', async () => {
        delete process.env.SOCIAL_BRIDGE_BASE_URL;
        // Newest first, as X lists them, with an old pinned tweet on top.
        mockFeedBodies.set(TIMELINE_URL, timelineBody([
            timelineTweet(1, 1600000000, { text: 'pinned' }),
            timelineTweet(3, 1758570300, { media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/media/m.jpg', width: 1, height: 1 }] } }),
            timelineTweet(2, 1758570000),
        ]));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1')] }];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(mockFetches).toEqual([TIMELINE_URL]);
        expect(client.send).toHaveBeenCalledTimes(1);
        const embed = client.send.mock.calls[0][0].embeds[0].data;
        expect(embed.description).toBe('post 3');
        expect(embed.url).toBe('https://x.com/NOTWOKESHOWS/status/3');
        expect(embed.image.url).toBe('https://pbs.twimg.com/media/m.jpg');
        expect(embed.author.name).toBe('NOT WOKE SHOWS.com (@NOTWOKESHOWS)');
        expect(Guild.updateOne).toHaveBeenCalledWith(
            { guildId: 'g1', 'socialFeeds._id': 'f1' },
            { $set: { 'socialFeeds.$.lastPublished': new Date(1758570300 * 1000) } },
        );
    });

    test('only tweets newer than the cursor post, oldest first', async () => {
        mockFeedBodies.set(TIMELINE_URL, timelineBody([
            timelineTweet(4, 1758570900), timelineTweet(3, 1758570600), timelineTweet(2, 1758570300),
        ]));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1', new Date(1758570300 * 1000))] }];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(client.send.mock.calls.map(c => c[0].embeds[0].data.description)).toEqual(['post 3', 'post 4']);
    });

    test('old bridge-URL and new profile-URL subscriptions to one account share one fetch', async () => {
        mockFeedBodies.set(TIMELINE_URL, timelineBody([timelineTweet(2, 1758570000)]));
        mockGuilds = [
            { guildId: 'g1', socialFeeds: [xFeed('f1', 'http://rsshub:1200/twitter/user/NOTWOKESHOWS', 'c1')] },
            { guildId: 'g2', socialFeeds: [{ ...xProfileFeed('f2', 'c2'), ref: '@notwokeshows' }] },
        ];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(mockFetches).toEqual([TIMELINE_URL]);
        expect(client.send).toHaveBeenCalledTimes(2);
    });

    test('a repost says which account reposted it, by that account’s own name', async () => {
        mockFeedBodies.set(TIMELINE_URL, timelineBody([
            timelineTweet(9, 1758570600, { url: 'https://x.com/studio/status/9', author: { name: 'Studio', screen_name: 'studio' } }),
            timelineTweet(2, 1758570000),
        ]));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1')] }];
        const client = makeClient();

        await checkSocialFeeds(client);

        const embed = client.send.mock.calls[0][0].embeds[0].data;
        expect(embed.author.name).toBe('Studio (@studio)');
        expect(embed.description.startsWith('-# 🔁 NOT WOKE SHOWS.com reposted')).toBe(true);
    });

    test('when FxTwitter fails the configured bridge is read instead', async () => {
        process.env.SOCIAL_BRIDGE_BASE_URL = 'https://rsshub.example.com';
        const bridgeUrl = 'https://rsshub.example.com/twitter/user/NOTWOKESHOWS';
        mockFeedBodies.set(TIMELINE_URL, new Error('Feed request failed with HTTP 503.'));
        mockFeedBodies.set(bridgeUrl, xXml({ description: 'from the bridge' }));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1')] }];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(mockFetches).toEqual([TIMELINE_URL, bridgeUrl]);
        expect(client.send.mock.calls[0][0].embeds[0].data.description).toBe('from the bridge');
        expect(feedFailCounts.size).toBe(0);
    });

    test('when every source fails the account counts one failure, keyed by handle', async () => {
        delete process.env.SOCIAL_BRIDGE_BASE_URL;
        mockFeedBodies.set(TIMELINE_URL, new Error('Feed request failed with HTTP 503.'));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1')] }];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
        expect(feedFailCounts.get('x:notwokeshows')).toBe(1);
        expect(Guild.updateOne).not.toHaveBeenCalled();
    });
});

// ── Review follow-ups (#1105) ──────────────────────────────────────────────

test('a quoted post X marked sensitive does not lend its picture outside age-restricted channels', async () => {
    const tweet = fxTweet({
        text: 'look at this',
        quote: {
            id: '7', url: 'https://x.com/other/status/7', text: 'nsfw',
            author: { name: 'Other', screen_name: 'other' },
            possibly_sensitive: true,
            media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/media/q.jpg', width: 1, height: 1 }] },
        },
    });
    const sfw = await sweepEnrichedX(tweet);
    expect(sfw[0].image).toBeUndefined();
    expect(sfw[0].description).toContain('Sensitive media hidden');

    const nsfw = await sweepEnrichedX(tweet, { nsfw: true });
    expect(nsfw[0].image.url).toBe('https://pbs.twimg.com/media/q.jpg');
    expect(nsfw[0].description).not.toContain('Sensitive media hidden');
});

describe('X timeline reposts and fallbacks', () => {
    const ORIGINAL_BRIDGE = process.env.SOCIAL_BRIDGE_BASE_URL;
    beforeEach(() => require('../src/services/xEnrichment').__test__.cache.clear());
    afterEach(() => {
        if (ORIGINAL_BRIDGE === undefined) delete process.env.SOCIAL_BRIDGE_BASE_URL;
        else process.env.SOCIAL_BRIDGE_BASE_URL = ORIGINAL_BRIDGE;
    });

    const oldRepost = () => timelineTweet(5, 1700000000, {
        url: 'https://x.com/studio/status/5', text: 'an old post', author: { name: 'Studio', screen_name: 'studio' },
    });

    test('reposting an old tweet after the cursor posts it once, and a later post does not bring it back', async () => {
        const cursor = new Date(1758570000 * 1000);
        // The repost is newer than own post 2 (listed below it), though the
        // tweet it reposts is far older than the cursor.
        mockFeedBodies.set(TIMELINE_URL, timelineBody([oldRepost(), timelineTweet(2, 1758570000)]));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1', cursor)] }];
        let client = makeClient();

        await checkSocialFeeds(client);

        expect(client.send).toHaveBeenCalledTimes(1);
        const embed = client.send.mock.calls[0][0].embeds[0].data;
        expect(embed.description).toContain('an old post');
        // The embed keeps the reposted tweet's own date.
        expect(embed.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
        const advanced = Guild.updateOne.mock.calls[0][1].$set['socialFeeds.$.lastPublished'];
        expect(advanced > cursor).toBe(true);

        // Next sweep: a new own post above the repost. Only it goes out.
        Guild.updateOne.mockClear();
        mockFeedBodies.set(TIMELINE_URL, timelineBody([timelineTweet(6, 1758571000), oldRepost(), timelineTweet(2, 1758570000)]));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1', advanced)] }];
        client = makeClient();

        await checkSocialFeeds(client);

        expect(client.send.mock.calls.map(c => c[0].embeds[0].data.description)).toEqual(['post 6']);
    });

    test('an old pinned post at the top of the timeline is not mistaken for new', async () => {
        const cursor = new Date(1758570000 * 1000);
        mockFeedBodies.set(TIMELINE_URL, timelineBody([timelineTweet(1, 1600000000, { text: 'pinned' }), timelineTweet(2, 1758570000)]));
        mockGuilds = [{ guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1', cursor)] }];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(client.send).not.toHaveBeenCalled();
    });

    test('every subscription’s stored bridge URL is tried before the account counts as failed', async () => {
        delete process.env.SOCIAL_BRIDGE_BASE_URL;
        const legacyUrl = 'https://oldbridge.example/twitter/user/NOTWOKESHOWS';
        mockFeedBodies.set(TIMELINE_URL, new Error('Feed request failed with HTTP 503.'));
        mockFeedBodies.set(legacyUrl, xXml({ description: 'from the old bridge' }));
        // The profile-URL subscription comes first; the legacy one holds the bridge.
        mockGuilds = [
            { guildId: 'g1', socialFeeds: [xProfileFeed('f1', 'c1')] },
            { guildId: 'g2', socialFeeds: [xFeed('f2', legacyUrl, 'c2')] },
        ];
        const client = makeClient();

        await checkSocialFeeds(client);

        expect(mockFetches).toEqual([TIMELINE_URL, legacyUrl]);
        expect(client.send).toHaveBeenCalledTimes(2);
        expect(feedFailCounts.size).toBe(0);
    });
});
