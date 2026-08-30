'use strict';

// The RSS routes address a feed by its *position* in the guild's list, and the
// delete handler did no checking at all: `splice(parseInt(index), 1)`.
//
// `parseInt('abc')` is NaN and `splice(NaN, 1)` removes element 0, so a request
// for a nonsense index deleted the first feed. A position past the end answered
// 200 having changed nothing. Neither mattered much while the page reloaded
// after every mutation and re-read the list from the database; now that it
// patches the list in place from the response (#689) they do, so both are
// checked and both are covered here — along with the feed list each mutation
// now answers with, which is what the page redraws from.

const express = require('express');
const request = require('supertest');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1', username: 'admin' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const rss = require('../src/dashboard/routes/api/rss');

const CHANNEL_ID = '111222333444555666';
const feed = name => ({ url: `https://${name}.example/feed.xml`, channelId: CHANNEL_ID });

let app;
let doc;
let errors;

function makeDoc(rssFeeds = []) {
    return { guildId: 'g1', rssFeeds, save: jest.fn(async () => {}) };
}

beforeEach(() => {
    jest.clearAllMocks();
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    doc = makeDoc();
    Guild.findOne.mockResolvedValue(doc);

    app = express();
    app.use(express.json());
    app.use('/api/v1', rss);
});

afterEach(() => errors.mockRestore());

const addFeed = body => request(app).post('/api/v1/guild/g1/rss/add').send(body);
const deleteFeed = index => request(app).delete(`/api/v1/guild/g1/rss/${index}`);

describe('POST /guild/:guildId/rss/add', () => {
    it('stores the feed and answers with the whole list', async () => {
        doc = makeDoc([feed('a')]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await addFeed({ url: '  https://b.example/feed.xml  ', channelId: CHANNEL_ID });

        expect(res.status).toBe(200);
        expect(doc.save).toHaveBeenCalled();
        // Trimmed on the way in, and the page redraws from what came back.
        expect(res.body).toEqual({
            success: true,
            feeds: [feed('a'), { url: 'https://b.example/feed.xml', channelId: CHANNEL_ID }],
        });
    });

    it.each([
        ['no url', { channelId: CHANNEL_ID }],
        ['a url that does not parse', { url: 'not a url', channelId: CHANNEL_ID }],
        ['a non-http scheme', { url: 'file:///etc/passwd', channelId: CHANNEL_ID }],
        ['no channel', { url: 'https://a.example/feed.xml' }],
        ['a channel that is not a snowflake', { url: 'https://a.example/feed.xml', channelId: 'general' }],
    ])('refuses %s', async (_label, body) => {
        const res = await addFeed(body);
        expect(res.status).toBe(400);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('404s for a guild with no settings row', async () => {
        Guild.findOne.mockResolvedValue(null);
        const res = await addFeed({ url: 'https://a.example/feed.xml', channelId: CHANNEL_ID });
        expect(res.status).toBe(404);
    });
});

describe('DELETE /guild/:guildId/rss/:index', () => {
    it('removes the feed at that position and answers with what is left', async () => {
        doc = makeDoc([feed('a'), feed('b'), feed('c')]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await deleteFeed(1);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, feeds: [feed('a'), feed('c')] });
        expect(doc.rssFeeds).toEqual([feed('a'), feed('c')]);
    });

    it.each(['abc', '1.5', '-1', 'NaN', ''])('refuses %p rather than deleting the first feed', async index => {
        doc = makeDoc([feed('a'), feed('b')]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await deleteFeed(index);

        // The empty string routes to a different path and 404s there; every
        // other one is a 400 from the handler. What matters for all of them is
        // that nothing was removed — `splice(NaN, 1)` used to take feed a.
        expect([400, 404]).toContain(res.status);
        expect(doc.rssFeeds).toEqual([feed('a'), feed('b')]);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('404s for a position past the end instead of answering 200 to a no-op', async () => {
        doc = makeDoc([feed('a')]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await deleteFeed(5);

        expect(res.status).toBe(404);
        expect(doc.rssFeeds).toEqual([feed('a')]);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('404s for a guild with no settings row rather than throwing', async () => {
        Guild.findOne.mockResolvedValue(null);
        const res = await deleteFeed(0);
        expect(res.status).toBe(404);
    });

    it('500s when the write fails, and says nothing about the internals', async () => {
        doc = makeDoc([feed('a')]);
        doc.save.mockRejectedValue(new Error('mongo is down'));
        Guild.findOne.mockResolvedValue(doc);

        const res = await deleteFeed(0);

        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain('mongo is down');
    });
});
