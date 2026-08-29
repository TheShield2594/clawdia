'use strict';

// `api/moderation.js` was at 14.5% lines and 0% branches — every guard in it
// unexecuted (#787). The guards are the file: which `?type=` values are allowed
// through to the query, what a malformed caseId does, and which of the four
// things the Discord half can answer with ("no guild", "no member", "the API
// refused") turns into which status.
//
// Driven through a real Express router with the models and the gateway facade
// stubbed, so what is asserted is the query the route issues and the body it
// writes.

const express = require('express');
const request = require('supertest');

jest.mock('../src/models/Case', () => ({ find: jest.fn(), countDocuments: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1', username: 'admin' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn(async () => {}),
}));

const Case = require('../src/models/Case');
const { logAuditEvent } = require('../src/dashboard/lib/apiHelpers');
const moderation = require('../src/dashboard/routes/api/moderation');

const USER_ID = '111222333444555666';

/** A chainable Mongoose query stub resolving to `rows`. */
function query(rows) {
    const q = {
        sort: jest.fn(() => q),
        skip: jest.fn(() => q),
        limit: jest.fn(() => q),
        lean: jest.fn(async () => rows),
    };
    return q;
}

let bot;
let app;
let errors;

beforeEach(() => {
    jest.clearAllMocks();
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    bot = {
        resolveUsers: jest.fn(async () => ({})),
        hasGuild: jest.fn(() => true),
        listBans: jest.fn(async () => []),
        listActiveTimeouts: jest.fn(() => []),
        unban: jest.fn(async () => true),
        clearTimeout: jest.fn(async () => true),
    };

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.bot = bot; next(); });
    app.use('/api/v1', moderation);

    Case.find.mockReturnValue(query([]));
    Case.countDocuments.mockResolvedValue(0);
});

afterEach(() => errors.mockRestore());

describe('GET /guild/:guildId/cases', () => {
    it('answers with the list envelope and decorates each case with its user tags', async () => {
        Case.find.mockReturnValue(query([
            { caseId: 1, targetUserId: 'u1', moderatorId: 'm1', type: 'warn' },
        ]));
        Case.countDocuments.mockResolvedValue(1);
        bot.resolveUsers.mockResolvedValue({
            u1: { tag: 'target#0001', avatarUrl: 'https://cdn/1.png' },
            m1: { tag: 'mod#0002', avatarUrl: null },
        });

        const res = await request(app).get('/api/v1/guild/g1/cases');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 1, page: 1, limit: 20 });
        expect(res.body.items[0]).toMatchObject({
            caseId: 1, targetUserTag: 'target#0001', targetAvatarUrl: 'https://cdn/1.png', moderatorTag: 'mod#0002',
        });
        // One lookup for the two distinct ids on the page, not one per case.
        expect(bot.resolveUsers).toHaveBeenCalledWith(['u1', 'm1']);
    });

    it('leaves the tags null for a user Discord could not resolve', async () => {
        Case.find.mockReturnValue(query([{ caseId: 1, targetUserId: 'gone', moderatorId: null }]));

        const res = await request(app).get('/api/v1/guild/g1/cases');

        expect(res.body.items[0]).toMatchObject({ targetUserTag: null, targetAvatarUrl: null, moderatorTag: null });
    });

    it('passes a known type and status into the query', async () => {
        await request(app).get('/api/v1/guild/g1/cases?type=ban&status=appealed');

        expect(Case.find).toHaveBeenCalledWith({ guildId: 'g1', type: 'ban', status: 'appealed' });
    });

    it('drops a type or status it does not recognise rather than querying for it', async () => {
        // An unknown value is a filter that matches nothing, which reads as "no
        // cases" — worse than ignoring it, and a free-text field on a query.
        await request(app).get('/api/v1/guild/g1/cases?type=nonsense&status=nonsense');

        expect(Case.find).toHaveBeenCalledWith({ guildId: 'g1' });
    });

    it('pages by page number and clamps the page size', async () => {
        const q = query([]);
        Case.find.mockReturnValue(q);

        await request(app).get('/api/v1/guild/g1/cases?page=3&limit=500');

        expect(q.limit).toHaveBeenCalledWith(50);
        expect(q.skip).toHaveBeenCalledWith(100);
    });

    it('500s a failed read rather than answering with a half-built page', async () => {
        Case.countDocuments.mockRejectedValue(new Error('mongo is down'));

        const res = await request(app).get('/api/v1/guild/g1/cases');

        expect(res.status).toBe(500);
    });
});

describe('PATCH /guild/:guildId/cases/:caseId', () => {
    function makeCase(overrides = {}) {
        return { caseId: 7, guildId: 'g1', status: 'open', notes: [], save: jest.fn(async () => {}), ...overrides };
    }

    const patch = (caseId, body) => request(app).patch(`/api/v1/guild/g1/cases/${caseId}`).send(body);

    it.each([undefined, 'delete', ''])('refuses the action %p', async action => {
        const res = await patch(7, action === undefined ? {} : { action });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('action must be "add_note" or "close"');
    });

    it('refuses a caseId that is not a number', async () => {
        const res = await patch('abc', { action: 'close' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid caseId');
    });

    it('404s a case that is not there', async () => {
        Case.findOne.mockResolvedValue(null);

        const res = await patch(7, { action: 'close' });

        expect(res.status).toBe(404);
    });

    it('appends a note attributed to the dashboard user, trimmed and capped', async () => {
        const c = makeCase();
        Case.findOne.mockResolvedValue(c);

        const res = await patch(7, { action: 'add_note', note: `  ${'n'.repeat(1200)}  ` });

        expect(res.status).toBe(200);
        expect(c.notes).toHaveLength(1);
        expect(c.notes[0].moderatorId).toBe('admin-1');
        expect(c.notes[0].content).toHaveLength(1000);
        expect(c.save).toHaveBeenCalled();
        expect(logAuditEvent).toHaveBeenCalledWith(expect.anything(), 'g1', 'case_update', { caseId: 7, action: 'add_note' });
    });

    it.each([undefined, '', '   ', 42])('refuses add_note with a note of %p', async note => {
        Case.findOne.mockResolvedValue(makeCase());

        const res = await patch(7, { action: 'add_note', note });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('note is required for add_note');
    });

    it('closes a case, recording who closed it and their resolution', async () => {
        const c = makeCase();
        Case.findOne.mockResolvedValue(c);

        const res = await patch(7, { action: 'close', resolution: `  ${'r'.repeat(600)}  ` });

        expect(res.status).toBe(200);
        expect(c.status).toBe('closed');
        expect(c.resolvedBy).toBe('admin-1');
        expect(c.resolvedAt).toBeInstanceOf(Date);
        expect(c.resolution).toHaveLength(500);
    });

    it('closes without a resolution when none was given', async () => {
        const c = makeCase();
        Case.findOne.mockResolvedValue(c);

        await patch(7, { action: 'close', resolution: 42 });

        expect(c.status).toBe('closed');
        expect(c.resolution).toBeUndefined();
    });

    it('500s a failed save', async () => {
        Case.findOne.mockResolvedValue(makeCase({ save: jest.fn().mockRejectedValue(new Error('mongo is down')) }));

        const res = await patch(7, { action: 'close' });

        expect(res.status).toBe(500);
    });
});

describe('GET /guild/:guildId/sanctions/active', () => {
    const get = () => request(app).get('/api/v1/guild/g1/sanctions/active');

    it('labels each entry with its kind and pads the two shapes to match', async () => {
        bot.listBans.mockResolvedValue([{ userId: 'u1', reason: 'spam' }]);
        bot.listActiveTimeouts.mockReturnValue([{ userId: 'u2', expires: '2026-01-01' }]);

        const res = await get();

        expect(res.status).toBe(200);
        expect(res.body.bans).toEqual([{ type: 'ban', userId: 'u1', reason: 'spam', expires: null }]);
        expect(res.body.timeouts).toEqual([{ type: 'timeout', userId: 'u2', expires: '2026-01-01', reason: null }]);
        // Both capped at Discord's own per-call ceiling.
        expect(bot.listBans).toHaveBeenCalledWith('g1', 200);
        expect(bot.listActiveTimeouts).toHaveBeenCalledWith('g1', 200);
    });

    it('404s a guild the bot is not in', async () => {
        bot.hasGuild.mockReturnValue(false);

        expect((await get()).status).toBe(404);
        expect(bot.listBans).not.toHaveBeenCalled();
    });

    it('503s a ban fetch Discord refused, naming permissions', async () => {
        // The guild is there; this is almost always a missing Ban Members
        // permission, and reporting it as a 500 would send the admin looking at
        // the wrong thing.
        bot.listBans.mockRejectedValue(new Error('Missing Permissions'));

        const res = await get();

        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/permissions/i);
    });

    it('copes with a timeout list the gateway had nothing for', async () => {
        bot.listActiveTimeouts.mockReturnValue(null);

        const res = await get();

        expect(res.body.timeouts).toEqual([]);
    });

    it('500s anything else that goes wrong', async () => {
        bot.listActiveTimeouts.mockImplementation(() => { throw new Error('boom'); });

        expect((await get()).status).toBe(500);
    });
});

describe('POST /guild/:guildId/sanctions/unban/:userId', () => {
    const unban = userId => request(app).post(`/api/v1/guild/g1/sanctions/unban/${userId}`);

    it('lifts the ban, attributing it to the dashboard user', async () => {
        const res = await unban(USER_ID);

        expect(res.status).toBe(200);
        expect(bot.unban).toHaveBeenCalledWith('g1', USER_ID, 'Unbanned via dashboard by admin');
        expect(logAuditEvent).toHaveBeenCalledWith(expect.anything(), 'g1', 'unban', { targetUserId: USER_ID });
    });

    it('refuses a userId that is not a snowflake, before calling Discord', async () => {
        const res = await unban('not-an-id');

        expect(res.status).toBe(400);
        expect(bot.unban).not.toHaveBeenCalled();
        expect(logAuditEvent).not.toHaveBeenCalled();
    });

    it('404s a guild the gateway does not have', async () => {
        bot.unban.mockResolvedValue(null);

        expect((await unban(USER_ID)).status).toBe(404);
    });

    it('surfaces the Discord error message on a failure', async () => {
        bot.unban.mockRejectedValue(new Error('Unknown Ban'));

        const res = await unban(USER_ID);

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Unknown Ban');
    });
});

describe('POST /guild/:guildId/sanctions/untimeout/:userId', () => {
    const untimeout = userId => request(app).post(`/api/v1/guild/g1/sanctions/untimeout/${userId}`);

    it('clears the timeout, attributing it to the dashboard user', async () => {
        const res = await untimeout(USER_ID);

        expect(res.status).toBe(200);
        expect(bot.clearTimeout).toHaveBeenCalledWith('g1', USER_ID, 'Timeout removed via dashboard by admin');
        expect(logAuditEvent).toHaveBeenCalledWith(expect.anything(), 'g1', 'untimeout', { targetUserId: USER_ID });
    });

    it('refuses a userId that is not a snowflake', async () => {
        expect((await untimeout('not-an-id')).status).toBe(400);
        expect(bot.clearTimeout).not.toHaveBeenCalled();
    });

    it.each([
        ['guild', null, 'Guild not found'],
        ['member', 'no-member', 'Member not found'],
    ])('404s a missing %s with its own message', async (_label, result, expected) => {
        bot.clearTimeout.mockResolvedValue(result);

        const res = await untimeout(USER_ID);

        expect(res.status).toBe(404);
        expect(res.body.error).toBe(expected);
    });

    it('surfaces the Discord error message on a failure', async () => {
        bot.clearTimeout.mockRejectedValue(new Error('Missing Permissions'));

        const res = await untimeout(USER_ID);

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Missing Permissions');
    });
});
