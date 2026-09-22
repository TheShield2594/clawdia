'use strict';

// GET /guild/:guildId/tickets — the dashboard's open-tickets table (#1012).
// It reads the live set off the Guild document and resolves opener/claimer ids
// to tags through the bot facade, newest first.

const express = require('express');
const request = require('supertest');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const stubBotGateway = require('./helpers/stubBotGateway');
const tickets = require('../src/dashboard/routes/api/tickets');

let bot;
let app;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    bot = stubBotGateway({
        resolveUsers: jest.fn(async ids => Object.fromEntries(ids.map(id => [id, { tag: `${id}#0001` }]))),
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.bot = bot; next(); });
    app.use('/api/v1', tickets);
});

afterEach(() => jest.restoreAllMocks());

const get = () => request(app).get('/api/v1/guild/g1/tickets');

it('returns open tickets newest-first with resolved tags', async () => {
    Guild.findOne.mockResolvedValue({ tickets: { open: [
        { ticketId: 1, threadId: 't1', openerId: 'alice', subject: 'a', claimedBy: null, openedAt: new Date('2026-01-01') },
        { ticketId: 2, threadId: 't2', openerId: 'bob', subject: 'b', claimedBy: 'mod', openedAt: new Date('2026-02-01') },
    ] } });

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.items.map(i => i.ticketId)).toEqual([2, 1]); // newest first
    expect(res.body.items[0]).toMatchObject({ openerTag: 'bob#0001', claimedByTag: 'mod#0001' });
    expect(res.body.items[1]).toMatchObject({ openerTag: 'alice#0001', claimedBy: null, claimedByTag: null });
    expect(bot.resolveUsers).toHaveBeenCalledWith(expect.arrayContaining(['alice', 'bob', 'mod']));
});

it('returns an empty list when there are no tickets, resolving nothing', async () => {
    Guild.findOne.mockResolvedValue({ tickets: { open: [] } });

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    expect(bot.resolveUsers).not.toHaveBeenCalled();
});

it('treats a guild with no settings document as no tickets', async () => {
    Guild.findOne.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
});

it('500s when the read throws', async () => {
    Guild.findOne.mockRejectedValue(new Error('mongo down'));
    const res = await get();
    expect(res.status).toBe(500);
});
