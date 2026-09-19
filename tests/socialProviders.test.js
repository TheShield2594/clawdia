'use strict';

// socialProviders turns what an admin pastes — a channel URL, an @handle, a
// subreddit — into a single pollable feed URL, and refuses the platforms that
// need a bridge when none is configured. These tests pin every resolution path
// and every refusal, with the one network read (YouTube handle → channel id)
// stubbed so nothing here reaches out.

const {
    PLATFORMS, BRIDGE_ENV_VAR, resolveSocialTarget, listProviders, isBridgeConfigured, getBridgeOrigin, __test__,
} = require('../src/services/socialProviders');

const OLD_ENV = process.env[BRIDGE_ENV_VAR];
afterEach(() => {
    if (OLD_ENV === undefined) delete process.env[BRIDGE_ENV_VAR];
    else process.env[BRIDGE_ENV_VAR] = OLD_ENV;
});

// A fetchText stub that returns a channel page carrying the id, or throws.
const pageWithChannelId = id => async () => `<html><body>{"channelId":"${id}"}</body></html>`;
const CHANNEL_ID = 'UC1234567890abcdefghijkl';

describe('the registry', () => {
    test('lists the five platforms with picker metadata', () => {
        expect(PLATFORMS).toEqual(['youtube', 'reddit', 'twitter', 'instagram', 'tiktok']);
        const providers = listProviders();
        expect(providers).toHaveLength(5);
        for (const p of providers) {
            expect(typeof p.label).toBe('string');
            expect(typeof p.requiresBridge).toBe('boolean');
            expect(typeof p.placeholder).toBe('string');
        }
    });

    test('only YouTube and Reddit work without a bridge', () => {
        const byId = Object.fromEntries(listProviders().map(p => [p.id, p]));
        expect(byId.youtube.requiresBridge).toBe(false);
        expect(byId.reddit.requiresBridge).toBe(false);
        expect(byId.twitter.requiresBridge).toBe(true);
        expect(byId.instagram.requiresBridge).toBe(true);
        expect(byId.tiktok.requiresBridge).toBe(true);
    });

    test('an unknown platform is refused', async () => {
        await expect(resolveSocialTarget('myspace', 'someone')).rejects.toThrow(/Unknown platform/);
    });

    test('empty input is refused before any resolution', async () => {
        await expect(resolveSocialTarget('youtube', '   ')).rejects.toThrow(/Enter an account/);
    });
});

describe('YouTube', () => {
    test('a bare channel id becomes the channel feed with no fetch', async () => {
        const fetchText = jest.fn();
        const r = await resolveSocialTarget('youtube', CHANNEL_ID, { fetchText });
        expect(r.feedUrl).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
        expect(fetchText).not.toHaveBeenCalled();
    });

    test('a /channel/ URL is read without a fetch', async () => {
        const fetchText = jest.fn();
        const r = await resolveSocialTarget('youtube', `https://www.youtube.com/channel/${CHANNEL_ID}`, { fetchText });
        expect(r.feedUrl).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
        expect(fetchText).not.toHaveBeenCalled();
    });

    test('an @handle is resolved by reading the channel page', async () => {
        const fetchText = jest.fn(pageWithChannelId(CHANNEL_ID));
        const r = await resolveSocialTarget('youtube', '@LinusTechTips', { fetchText });
        expect(fetchText).toHaveBeenCalledWith('https://www.youtube.com/@LinusTechTips');
        expect(r.ref).toBe('@LinusTechTips');
        expect(r.feedUrl).toBe(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
    });

    test('a full @handle URL resolves the same way', async () => {
        const fetchText = jest.fn(pageWithChannelId(CHANNEL_ID));
        const r = await resolveSocialTarget('youtube', 'https://youtube.com/@mkbhd', { fetchText });
        expect(r.feedUrl).toContain(CHANNEL_ID);
    });

    test('a legacy /user/ URL uses the user feed, no fetch', async () => {
        const fetchText = jest.fn();
        const r = await resolveSocialTarget('youtube', 'https://www.youtube.com/user/Vsauce', { fetchText });
        expect(r.feedUrl).toBe('https://www.youtube.com/feeds/videos.xml?user=Vsauce');
        expect(fetchText).not.toHaveBeenCalled();
    });

    test('an already-built feed URL is passed through untouched', async () => {
        const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
        const r = await resolveSocialTarget('youtube', url, { fetchText: jest.fn() });
        expect(r.feedUrl).toBe(url);
    });

    test('a feed path on another host is not accepted as a YouTube feed', async () => {
        // The passthrough is parsed, not substring-matched, so this does not slip
        // through as `feedUrl: raw`.
        await expect(resolveSocialTarget('youtube', 'https://example.com/youtube.com/feeds/videos.xml', { fetchText: jest.fn() }))
            .rejects.toThrow(/not a YouTube link/);
    });

    test('a page with no channel id gives an actionable error', async () => {
        const fetchText = jest.fn(async () => '<html>nothing useful</html>');
        await expect(resolveSocialTarget('youtube', '@ghost', { fetchText }))
            .rejects.toThrow(/Could not find a channel/);
    });

    test('a non-YouTube URL is refused', async () => {
        await expect(resolveSocialTarget('youtube', 'https://example.com/x', { fetchText: jest.fn() }))
            .rejects.toThrow(/not a YouTube link/);
    });

    test('extractChannelId reads the canonical link form too', () => {
        const html = '<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">';
        expect(__test__.extractChannelId(html)).toBe('UCabcdefghijklmnopqrstuv');
    });
});

describe('Reddit', () => {
    test('a bare word is taken as a subreddit', async () => {
        const r = await resolveSocialTarget('reddit', 'aww');
        expect(r).toMatchObject({ ref: 'r/aww', feedUrl: 'https://www.reddit.com/r/aww/.rss' });
    });

    test('r/name and a full URL agree', async () => {
        const a = await resolveSocialTarget('reddit', 'r/programming');
        const b = await resolveSocialTarget('reddit', 'https://www.reddit.com/r/programming/');
        expect(a.feedUrl).toBe('https://www.reddit.com/r/programming/.rss');
        expect(b.feedUrl).toBe(a.feedUrl);
    });

    test('u/name and user/name resolve to the user feed', async () => {
        const a = await resolveSocialTarget('reddit', 'u/spez');
        const b = await resolveSocialTarget('reddit', 'https://reddit.com/user/spez');
        expect(a.feedUrl).toBe('https://www.reddit.com/user/spez/.rss');
        expect(b.feedUrl).toBe(a.feedUrl);
    });

    test('a non-reddit URL is refused', async () => {
        await expect(resolveSocialTarget('reddit', 'https://example.com/r/x')).rejects.toThrow(/not a reddit link/);
    });

    test('a subreddit name with illegal characters is refused', async () => {
        await expect(resolveSocialTarget('reddit', 'r/has spaces')).rejects.toThrow();
    });
});

describe('bridged platforms', () => {
    test('refuse with an actionable message when no bridge is configured', async () => {
        delete process.env[BRIDGE_ENV_VAR];
        expect(isBridgeConfigured()).toBe(false);
        await expect(resolveSocialTarget('twitter', '@jack')).rejects.toThrow(new RegExp(BRIDGE_ENV_VAR));
    });

    test('build <bridge>/<route> when a bridge is set', async () => {
        process.env[BRIDGE_ENV_VAR] = 'https://rsshub.example.com';
        expect(isBridgeConfigured()).toBe(true);
        expect((await resolveSocialTarget('twitter', '@jack')).feedUrl)
            .toBe('https://rsshub.example.com/twitter/user/jack');
        expect((await resolveSocialTarget('instagram', 'https://instagram.com/natgeo')).feedUrl)
            .toBe('https://rsshub.example.com/instagram/user/natgeo');
        expect((await resolveSocialTarget('tiktok', '@gordonramsayofficial')).feedUrl)
            .toBe('https://rsshub.example.com/tiktok/user/@gordonramsayofficial');
    });

    test('getBridgeOrigin returns the origin with any path stripped, or null', async () => {
        delete process.env[BRIDGE_ENV_VAR];
        expect(getBridgeOrigin()).toBeNull();
        process.env[BRIDGE_ENV_VAR] = 'https://rsshub.example.com/rss';
        expect(getBridgeOrigin()).toBe('https://rsshub.example.com');
        process.env[BRIDGE_ENV_VAR] = 'http://rsshub:1200';
        expect(getBridgeOrigin()).toBe('http://rsshub:1200');
    });

    test('a trailing slash on the bridge base does not double up', async () => {
        process.env[BRIDGE_ENV_VAR] = 'https://rsshub.example.com/';
        expect((await resolveSocialTarget('twitter', 'jack')).feedUrl)
            .toBe('https://rsshub.example.com/twitter/user/jack');
    });

    test('a bridge on a sub-path keeps the path', async () => {
        process.env[BRIDGE_ENV_VAR] = 'https://host.example/rss';
        expect((await resolveSocialTarget('twitter', 'jack')).feedUrl)
            .toBe('https://host.example/rss/twitter/user/jack');
    });

    test('a bridge that is not a public http(s) URL is rejected', async () => {
        process.env[BRIDGE_ENV_VAR] = 'ftp://nope';
        await expect(resolveSocialTarget('twitter', 'jack')).rejects.toThrow(new RegExp(`${BRIDGE_ENV_VAR} is not usable`));
    });

    test('a bridge pointed at a literal private address is rejected', async () => {
        process.env[BRIDGE_ENV_VAR] = 'http://169.254.169.254';
        await expect(resolveSocialTarget('twitter', 'jack')).rejects.toThrow(/not usable/);
    });

    test('an X username over 15 chars is refused', async () => {
        process.env[BRIDGE_ENV_VAR] = 'https://rsshub.example.com';
        await expect(resolveSocialTarget('twitter', 'a'.repeat(16))).rejects.toThrow(/not a valid X/);
    });
});
