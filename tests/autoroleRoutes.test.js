'use strict';

// The autorole route hands a role to every member who joins (#1061). A role
// carrying admin or moderator permissions must never be one of them, so the
// route refuses it at configuration time — this is the test for that gate, plus
// the ordinary add/remove behaviour it grew around.

const express = require('express');
const request = require('supertest');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1', username: 'admin' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const stubBotGateway = require('./helpers/stubBotGateway');
const autorole = require('../src/dashboard/routes/api/autorole');

const ROLE_ID = '222333444555666777';

let bot;
let app;
let doc;

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});

    bot = stubBotGateway({ listRoles: jest.fn(async () => []) });
    doc = { guildId: 'g1', autoRoles: [], save: jest.fn(async () => {}) };
    Guild.findOne.mockResolvedValue(doc);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.bot = bot; next(); });
    app.use('/api/v1', autorole);
});

afterEach(() => jest.restoreAllMocks());

const add = roleId => request(app).post('/api/v1/guild/g1/autorole').send({ roleId });

describe('POST /guild/:guildId/autorole', () => {
    it('adds a role with no deny-set permissions', async () => {
        bot.listRoles.mockResolvedValue([{ id: ROLE_ID, name: 'Member', position: 1, managed: false, dangerousPermissions: [] }]);

        const res = await add(ROLE_ID);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(doc.autoRoles).toEqual([{ roleId: ROLE_ID }]);
        expect(doc.save).toHaveBeenCalled();
    });

    it('adds a role the bot has no permission view of (listRoles null)', async () => {
        // The event handler is the backstop when the config route cannot see the
        // role; the route should not fail closed and lock out a normal setup.
        bot.listRoles.mockResolvedValue(null);

        const res = await add(ROLE_ID);

        expect(res.status).toBe(200);
        expect(doc.autoRoles).toEqual([{ roleId: ROLE_ID }]);
    });

    it('refuses a role carrying admin or moderator permissions, naming it', async () => {
        bot.listRoles.mockResolvedValue([
            { id: ROLE_ID, name: 'Staff', position: 9, managed: false, dangerousPermissions: ['Administrator'] },
        ]);

        const res = await add(ROLE_ID);

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Staff');
        expect(res.body.error).toContain('Administrator');
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('does not duplicate a role already configured', async () => {
        doc.autoRoles = [{ roleId: ROLE_ID }];
        bot.listRoles.mockResolvedValue([{ id: ROLE_ID, name: 'Member', position: 1, managed: false, dangerousPermissions: [] }]);

        const res = await add(ROLE_ID);

        expect(res.status).toBe(200);
        expect(doc.autoRoles).toEqual([{ roleId: ROLE_ID }]);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('refuses a missing roleId', async () => {
        const res = await request(app).post('/api/v1/guild/g1/autorole').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('roleId required');
    });

    it('refuses a roleId that is not a snowflake', async () => {
        const res = await add('not-a-snowflake');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('roleId must be a valid Discord snowflake');
    });

    it('404s a guild with no settings document', async () => {
        bot.listRoles.mockResolvedValue([]);
        Guild.findOne.mockResolvedValue(null);

        const res = await add(ROLE_ID);

        expect(res.status).toBe(404);
    });
});

describe('DELETE /guild/:guildId/autorole/:roleId', () => {
    const remove = roleId => request(app).delete(`/api/v1/guild/g1/autorole/${roleId}`);

    it('removes the role and saves', async () => {
        doc.autoRoles = [{ roleId: ROLE_ID }, { roleId: '999' }];

        const res = await remove(ROLE_ID);

        expect(res.status).toBe(200);
        expect(doc.autoRoles).toEqual([{ roleId: '999' }]);
        expect(doc.save).toHaveBeenCalled();
    });

    it('404s a guild with no settings document', async () => {
        Guild.findOne.mockResolvedValue(null);
        expect((await remove(ROLE_ID)).status).toBe(404);
    });
});
