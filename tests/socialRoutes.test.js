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
jest.mock('../src/utils/safeFeedFetch', () => ({
    safeFetchFeed: jest.fn(async () => { if (mockFeedThrows) throw mockFeedThrows; return mockFeedBody; }),
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

function makeDoc(socialFeeds = []) {
    return { guildId: 'g1', socialFeeds, save: jest.fn(async () => {}) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFeedThrows = null;
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    doc = makeDoc();
    Guild.findOne.mockResolvedValue(doc);
    app = express();
    app.use(express.json());
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
});

describe('POST /social/validate', () => {
    it('confirms a resolvable, fetchable account', async () => {
        const res = await validate({ platform: 'reddit', input: 'r/programming' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ valid: true, ref: 'r/programming', itemCount: 1 });
    });

    it('reports the resolver error for a bad account', async () => {
        const res = await validate({ platform: 'twitter', input: '@jack' }); // no bridge configured
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toMatch(/bridge/i);
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
