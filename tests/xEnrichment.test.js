'use strict';

// xEnrichment turns an RSSHub X item's permalink into FxTwitter's normalised
// tweet. These pin the link parsing, the payload normalisation across the API's
// v1 (`tweet`) and v2 (`status`) shapes, and that every failure is a null the
// sweep can fall back from rather than an error that stops a post.

const { fetchTweetDetails, parseStatusLink, formatDuration, __test__ } = require('../src/services/xEnrichment');
const { normaliseTweet, getApiBase, largeAvatar, cache } = __test__;

const ORIGINAL_ENV = process.env.SOCIAL_X_API_BASE_URL;

afterEach(() => {
    cache.clear();
    if (ORIGINAL_ENV === undefined) delete process.env.SOCIAL_X_API_BASE_URL;
    else process.env.SOCIAL_X_API_BASE_URL = ORIGINAL_ENV;
    jest.restoreAllMocks();
});

function fxTweet(overrides = {}) {
    return {
        id: '1900000000000000001',
        url: 'https://x.com/NOTWOKESHOWS/status/1900000000000000001',
        text: 'MobLand is a crime drama series.',
        created_timestamp: 1758570000,
        author: { name: 'NOT WOKE SHOWS.com', screen_name: 'NOTWOKESHOWS', avatar_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
        media: {},
        replying_to: null,
        possibly_sensitive: false,
        ...overrides,
    };
}

test('parseStatusLink reads the handle and id from X permalinks only', () => {
    expect(parseStatusLink('https://x.com/NOTWOKESHOWS/status/123')).toEqual({ user: 'NOTWOKESHOWS', id: '123' });
    expect(parseStatusLink('https://twitter.com/jack/status/20?s=20')).toEqual({ user: 'jack', id: '20' });
    expect(parseStatusLink('https://mobile.twitter.com/jack/statuses/20')).toEqual({ user: 'jack', id: '20' });
    expect(parseStatusLink('https://x.com/i/web/status/99')).toEqual({ user: 'i', id: '99' });
    expect(parseStatusLink('https://x.com/jack')).toBeNull();
    expect(parseStatusLink('https://evil.example/jack/status/1')).toBeNull();
    expect(parseStatusLink('https://x.com.evil.example/jack/status/1')).toBeNull();
    expect(parseStatusLink('not a url')).toBeNull();
    expect(parseStatusLink(undefined)).toBeNull();
});

test('the API base defaults to FxTwitter, can be pointed elsewhere, or turned off', () => {
    delete process.env.SOCIAL_X_API_BASE_URL;
    expect(getApiBase()).toBe('https://api.fxtwitter.com');
    process.env.SOCIAL_X_API_BASE_URL = 'https://fx.example.com/';
    expect(getApiBase()).toBe('https://fx.example.com');
    process.env.SOCIAL_X_API_BASE_URL = 'off';
    expect(getApiBase()).toBeNull();
    process.env.SOCIAL_X_API_BASE_URL = 'ftp://fx.example.com';
    expect(getApiBase()).toBeNull();
});

test('normaliseTweet keeps media order, video thumbnails, quote, card and reply', () => {
    const t = normaliseTweet(fxTweet({
        media: {
            all: [
                { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1, height: 1, altText: 'poster' },
                { type: 'video', url: 'https://video.twimg.com/v.mp4', thumbnail_url: 'https://pbs.twimg.com/thumb.jpg', duration: 75.2, width: 1, height: 1 },
                { type: 'video', url: 'https://video.twimg.com/nothumb.mp4', duration: 1, width: 1, height: 1 },
            ],
        },
        quote: fxTweet({ id: '5', url: 'https://x.com/other/status/5', text: 'quoted', author: { name: 'Other', screen_name: 'other' } }),
        card: { url: 'https://www.notwokeshows.com/show/mobland-2025', title: 'MobLand', domain: 'notwokeshows.com', image: { url: 'https://pbs.twimg.com/card.jpg' } },
        replying_to: { screen_name: 'someone', status: '4' },
    }));
    expect(t.author).toEqual({
        name: 'NOT WOKE SHOWS.com',
        handle: 'NOTWOKESHOWS',
        avatar: 'https://pbs.twimg.com/profile_images/1/a_400x400.jpg',
        url: 'https://x.com/NOTWOKESHOWS',
    });
    expect(t.media).toEqual([
        { type: 'photo', image: 'https://pbs.twimg.com/media/a.jpg', alt: 'poster' },
        { type: 'video', image: 'https://pbs.twimg.com/thumb.jpg', duration: 75.2, url: 'https://video.twimg.com/v.mp4' },
    ]);
    expect(t.quote.author.handle).toBe('other');
    expect(t.quote.quote).toBeNull(); // quotes of quotes are not followed
    expect(t.card.title).toBe('MobLand');
    expect(t.replyingTo).toBe('someone');
    expect(t.createdAt.toISOString()).toBe(new Date(1758570000 * 1000).toISOString());
});

test('normaliseTweet accepts the v1 bare-string reply target and rejects junk', () => {
    expect(normaliseTweet(fxTweet({ replying_to: 'jack' })).replyingTo).toBe('jack');
    expect(normaliseTweet(null)).toBeNull();
    expect(normaliseTweet({ type: 'tombstone' })).toBeNull();
    expect(normaliseTweet({ text: 'no author' })).toBeNull();
});

test('helpers format durations and upgrade avatars', () => {
    expect(formatDuration(75.2)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(largeAvatar('https://pbs.twimg.com/p/x_normal.png')).toBe('https://pbs.twimg.com/p/x_400x400.png');
    expect(largeAvatar('javascript:alert(1)')).toBeNull();
});

test('fetchTweetDetails looks the tweet up once and caches it for every guild', async () => {
    delete process.env.SOCIAL_X_API_BASE_URL;
    const fetchText = jest.fn(async () => JSON.stringify({ code: 200, tweet: fxTweet() }));
    const link = 'https://x.com/NOTWOKESHOWS/status/1900000000000000001';

    const a = await fetchTweetDetails(link, { fetchText });
    const b = await fetchTweetDetails(link, { fetchText });

    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith('https://api.fxtwitter.com/NOTWOKESHOWS/status/1900000000000000001');
    expect(a.text).toBe('MobLand is a crime drama series.');
    expect(b).toBe(a);
});

test('the v2 `status` payload shape is read too', async () => {
    const fetchText = jest.fn(async () => JSON.stringify({ code: 200, status: fxTweet({ text: 'v2' }) }));
    const t = await fetchTweetDetails('https://x.com/NOTWOKESHOWS/status/1', { fetchText });
    expect(t.text).toBe('v2');
});

test('every failure is a null, and a failure is not cached', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const link = 'https://x.com/NOTWOKESHOWS/status/2';

    const down = jest.fn(async () => { throw new Error('HTTP 503'); });
    expect(await fetchTweetDetails(link, { fetchText: down })).toBeNull();

    const garbage = jest.fn(async () => '<html>not json</html>');
    expect(await fetchTweetDetails(link, { fetchText: garbage })).toBeNull();

    const busy = jest.fn(async () => JSON.stringify({ code: 500, message: 'API_FAIL' }));
    expect(await fetchTweetDetails(link, { fetchText: busy })).toBeNull();

    // Each attempt above reached the API — the earlier failures did not stick.
    expect(down).toHaveBeenCalledTimes(1);
    expect(garbage).toHaveBeenCalledTimes(1);
    expect(busy).toHaveBeenCalledTimes(1);
});

test('a deleted tweet is a null that is remembered, not re-asked every delivery', async () => {
    const gone = jest.fn(async () => JSON.stringify({ code: 404, message: 'NOT_FOUND' }));
    const link = 'https://x.com/NOTWOKESHOWS/status/3';
    expect(await fetchTweetDetails(link, { fetchText: gone })).toBeNull();
    expect(await fetchTweetDetails(link, { fetchText: gone })).toBeNull();
    expect(gone).toHaveBeenCalledTimes(1);
});

test('non-X links and disabled lookups never fetch', async () => {
    const fetchText = jest.fn();
    expect(await fetchTweetDetails('https://x/post', { fetchText })).toBeNull();
    process.env.SOCIAL_X_API_BASE_URL = 'off';
    expect(await fetchTweetDetails('https://x.com/a/status/1', { fetchText })).toBeNull();
    expect(fetchText).not.toHaveBeenCalled();
});

describe('fetchProfileTimeline', () => {
    const { fetchProfileTimeline } = require('../src/services/xEnrichment');

    test('reads the v2 timeline, flattens grouped threads and primes the per-id cache', async () => {
        delete process.env.SOCIAL_X_API_BASE_URL;
        const fetchText = jest.fn(async () => JSON.stringify({
            code: 200,
            results: [
                fxTweet({ id: '1', url: 'https://x.com/NOTWOKESHOWS/status/1' }),
                { type: 'thread', conversation_id: '2', statuses: [fxTweet({ id: '2' }), fxTweet({ id: '3' })] },
                { type: 'tombstone' },
            ],
        }));

        const tweets = await fetchProfileTimeline('NOTWOKESHOWS', { fetchText });

        expect(fetchText).toHaveBeenCalledWith('https://api.fxtwitter.com/2/profile/NOTWOKESHOWS/statuses?count=20');
        expect(tweets.map(t => t.id)).toEqual(['1', '2', '3']);
        // A later per-id lookup of one of these is answered from the cache.
        const lookup = jest.fn();
        expect((await fetchTweetDetails('https://x.com/NOTWOKESHOWS/status/1', { fetchText: lookup })).id).toBe('1');
        expect(lookup).not.toHaveBeenCalled();
    });

    test('throws readable errors so the sweep can fall back to the bridge', async () => {
        const notFound = jest.fn(async () => JSON.stringify({ code: 404, results: [] }));
        await expect(fetchProfileTimeline('nobody', { fetchText: notFound })).rejects.toThrow(/@nobody was not found/);

        const html = jest.fn(async () => '<html>');
        await expect(fetchProfileTimeline('jack', { fetchText: html })).rejects.toThrow(/did not answer with JSON/);

        process.env.SOCIAL_X_API_BASE_URL = 'off';
        await expect(fetchProfileTimeline('jack', { fetchText: html })).rejects.toThrow(/turned off/);
    });
});
