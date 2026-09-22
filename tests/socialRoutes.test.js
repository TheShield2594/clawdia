'use strict';

// The social API router: resolve-then-store on add, the same position-addressed
// list contract the RSS routes have (#689), and the validation that keeps a bad
// platform, channel, or account out of the guild document.

const express = require('express');
const request = require('supertest');

// validate fetches the resolved feed; a stub keeps the test off the network and
// lets the "resolved but unfetchable" branch be exercised too.
const mockFeedBody = '<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>a</title><link>https://x/a</link></item></channel></rss>';
let mockFeedThrows = null;
// Per-URL bodies for the X tests, where FxTwitter answers JSON and the bridge RSS.
let mockBodies = new Map();
jest.mock('../src/utils/safeFeedFetch', () => ({
    safeFetchFeed: jest.fn(async url => {
        if (mockFeedThrows) throw mockFeedThrows;
        const body = mockBodies.get(url);
        if (body instanceof Error) throw body;
        return body === undefined ? mockFeedBody : body;
    }),
}));

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const social = require('../src/dashboard/routes/api/social');

const CHANNEL_ID = '111222333444555666';
let app;
let doc;
let errors;
let hasChannel; // req.bot.hasChannel stub — true unless a test overrides it

function makeDoc(socialFeeds = []) {
    return { guildId: 'g1', socialFeeds, save: jest.fn(async () => {}) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFeedThrows = null;
    mockBodies = new Map();
    require('../src/services/xEnrichment').__test__.cache.clear();
    hasChannel = jest.fn(async () => true);
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    doc = makeDoc();
    Guild.findOne.mockResolvedValue(doc);
    app = express();
    app.use(express.json());
    // The dashboard injects req.bot app-wide; the add route uses it to confirm
    // the target channel belongs to the guild.
    app.use((req, _res, next) => { req.bot = { hasChannel }; next(); });
    app.use('/api/v1', social);
});

afterEach(() => errors.mockRestore());

const add = body => request(app).post('/api/v1/guild/g1/social/add').send(body);
const del = index => request(app).delete(`/api/v1/guild/g1/social/${index}`);
const validate = body => request(app).post('/api/v1/guild/g1/social/validate').send(body);

describe('POST /social/add', () => {
    it('resolves a reddit subreddit and stores the normalised subscription', async () => {
        const res = await add({ platform: 'reddit', input: 'r/aww', channelId: CHANNEL_ID });

        expect(res.status).toBe(200);
        expect(doc.save).toHaveBeenCalled();
        expect(doc.socialFeeds[0]).toMatchObject({
            platform: 'reddit',
            ref: 'r/aww',
            feedUrl: 'https://www.reddit.com/r/aww/.rss',
            channelId: CHANNEL_ID,
        });
        expect(res.body.feeds[0]).toMatchObject({ platform: 'reddit', ref: 'r/aww', channelId: CHANNEL_ID });
    });

    it('resolves a YouTube channel id without a network call', async () => {
        const res = await add({ platform: 'youtube', input: 'UC1234567890abcdefghijkl', channelId: CHANNEL_ID });
        expect(res.status).toBe(200);
        expect(doc.socialFeeds[0].feedUrl).toContain('channel_id=UC1234567890abcdefghijkl');
    });

    it.each([
        ['unknown platform', { platform: 'myspace', input: 'x', channelId: CHANNEL_ID }],
        ['no input', { platform: 'reddit', channelId: CHANNEL_ID }],
        ['no channel', { platform: 'reddit', input: 'r/aww' }],
        ['a channel that is not a snowflake', { platform: 'reddit', input: 'r/aww', channelId: 'general' }],
    ])('refuses %s', async (_label, body) => {
        const res = await add(body);
        expect(res.status).toBe(400);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('400s with the resolver message when the account cannot be resolved', async () => {
        const res = await add({ platform: 'reddit', input: 'https://example.com/notreddit', channelId: CHANNEL_ID });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not a reddit link/);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('404s for a guild with no settings row', async () => {
        Guild.findOne.mockResolvedValue(null);
        const res = await add({ platform: 'reddit', input: 'r/aww', channelId: CHANNEL_ID });
        expect(res.status).toBe(404);
    });

    it('400s a channel that is not in this guild, without resolving or saving', async () => {
        hasChannel.mockResolvedValue(false);
        const res = await add({ platform: 'reddit', input: 'r/aww', channelId: CHANNEL_ID });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/channel in this server/);
        expect(hasChannel).toHaveBeenCalledWith('g1', CHANNEL_ID);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('409s a duplicate subscription for the same feed and channel', async () => {
        doc = makeDoc([{ platform: 'reddit', ref: 'r/aww', feedUrl: 'https://www.reddit.com/r/aww/.rss', channelId: CHANNEL_ID }]);
        Guild.findOne.mockResolvedValue(doc);
        const res = await add({ platform: 'reddit', input: 'r/aww', channelId: CHANNEL_ID });
        expect(res.status).toBe(409);
        expect(doc.save).not.toHaveBeenCalled();
        // A different channel for the same account is not a duplicate.
        const res2 = await add({ platform: 'reddit', input: 'r/aww', channelId: '222333444555666777' });
        expect(res2.status).toBe(200);
    });

    it('stores an X account by its profile URL, with no bridge needed', async () => {
        const res = await add({ platform: 'twitter', input: 'https://x.com/NOTWOKESHOWS', channelId: CHANNEL_ID });
        expect(res.status).toBe(200);
        expect(doc.socialFeeds[0]).toMatchObject({
            platform: 'twitter', ref: '@NOTWOKESHOWS', feedUrl: 'https://x.com/NOTWOKESHOWS',
        });
    });

    it('409s an X account already followed through the bridge in that channel', async () => {
        doc = makeDoc([{ platform: 'twitter', ref: '@NotWokeShows', feedUrl: 'http://rsshub:1200/twitter/user/NotWokeShows', channelId: CHANNEL_ID }]);
        Guild.findOne.mockResolvedValue(doc);
        const res = await add({ platform: 'twitter', input: '@notwokeshows', channelId: CHANNEL_ID });
        expect(res.status).toBe(409);
        expect(doc.save).not.toHaveBeenCalled();
    });
});

describe('POST /social/validate', () => {
    it('confirms a resolvable, fetchable account', async () => {
        const res = await validate({ platform: 'reddit', input: 'r/programming' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ valid: true, ref: 'r/programming', itemCount: 1 });
    });

    it('reports the resolver error for a bad account', async () => {
        const res = await validate({ platform: 'instagram', input: '@someone' }); // no bridge configured
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toMatch(/bridge/i);
    });

    it('tests an X account against the FxTwitter timeline the sweep will read', async () => {
        mockBodies.set('https://api.fxtwitter.com/2/profile/jack/statuses?count=20', JSON.stringify({
            code: 200,
            results: [{
                id: '20', url: 'https://x.com/jack/status/20', text: 'just setting up my twttr',
                created_timestamp: 1142974214,
                author: { name: 'jack', screen_name: 'jack' },
                media: {},
            }],
        }));
        const res = await validate({ platform: 'twitter', input: '@jack' });
        expect(res.body).toMatchObject({ valid: true, ref: '@jack', title: 'jack (@jack)', itemCount: 1 });
    });

    it('explains an X account FxTwitter cannot read, with no bridge to fall back to', async () => {
        mockBodies.set('https://api.fxtwitter.com/2/profile/jack/statuses?count=20', '<html>blocked</html>');
        const res = await validate({ platform: 'twitter', input: '@jack' });
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toMatch(/FxTwitter did not answer with JSON/);
    });

    it('reports a resolved-but-unfetchable account without 500ing', async () => {
        mockFeedThrows = new Error('404 Not Found');
        const res = await validate({ platform: 'reddit', input: 'r/thisdoesnotexist' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ valid: false });
        expect(res.body.error).toMatch(/404/);
    });

    it('400s an unknown platform', async () => {
        const res = await validate({ platform: 'myspace', input: 'x' });
        expect(res.status).toBe(400);
    });
});

describe('DELETE /social/:index', () => {
    const feed = ref => ({ platform: 'reddit', ref, feedUrl: `https://www.reddit.com/r/${ref}/.rss`, channelId: CHANNEL_ID });

    it('removes the subscription at that position and answers with what is left', async () => {
        doc = makeDoc([feed('a'), feed('b'), feed('c')]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await del(1);

        expect(res.status).toBe(200);
        expect(res.body.feeds.map(f => f.ref)).toEqual(['a', 'c']);
        expect(doc.socialFeeds.map(f => f.ref)).toEqual(['a', 'c']);
    });

    it.each(['abc', '1.5', '-1', 'NaN', ''])('refuses %p rather than deleting the first', async index => {
        doc = makeDoc([feed('a'), feed('b')]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await del(index);

        expect([400, 404]).toContain(res.status);
        expect(doc.socialFeeds.map(f => f.ref)).toEqual(['a', 'b']);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('404s for a position past the end', async () => {
        doc = makeDoc([feed('a')]);
        Guild.findOne.mockResolvedValue(doc);
        const res = await del(5);
        expect(res.status).toBe(404);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('500s when the write fails, saying nothing about the internals', async () => {
        doc = makeDoc([feed('a')]);
        doc.save.mockRejectedValue(new Error('mongo is down'));
        Guild.findOne.mockResolvedValue(doc);

        const res = await del(0);

        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('mongo is down');
    });
});
