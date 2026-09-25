'use strict';

// #1161: `?q=a&q=b` arrives as an array, which has no .trim(), and the member
// search answered it with a 500. A non-string query is now no query.

jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    requireGuildPermission: () => (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const router = require('../src/dashboard/routes/api/members');

function makeApp(bot) {
    const app = express();
    app.use((req, _res, next) => { req.bot = bot; next(); });
    app.use('/api', router);
    return app;
}

describe('member search and resolve coerce their query to a string', () => {
    const bot = {
        searchMembers: jest.fn().mockResolvedValue([{ id: '1', username: 'a', displayName: 'A', avatarUrl: null }]),
        resolveUsers: jest.fn().mockResolvedValue({}),
    };
    const app = makeApp(bot);
    beforeEach(() => jest.clearAllMocks());

    test.each([
        ['a repeated q', '/api/guild/123/members/search?q=ab&q=cd'],
        ['an object q', '/api/guild/123/members/search?q[x]=ab'],
    ])('%s is an empty search, not a 500', async (_, url) => {
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ items: [] });
        expect(bot.searchMembers).not.toHaveBeenCalled();
    });

    test('a single q still searches', async () => {
        const res = await request(app).get('/api/guild/123/members/search?q=ab');
        expect(res.status).toBe(200);
        expect(bot.searchMembers).toHaveBeenCalledWith('123', 'ab', 10);
    });

    test('a repeated ids is an empty resolve, not a 500', async () => {
        const res = await request(app).get('/api/guild/123/members/resolve?ids=1&ids=2');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
    });
});
