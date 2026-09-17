'use strict';

// The moderator's end of the ledger (#1009): GET a member's transactions from
// the dashboard, newest first and paged, with the counterparty resolved to a
// name and every owed payout still outstanding attached beside them. Read-only —
// the route issues no write.

const express = require('express');
const request = require('supertest');
const stubBotGateway = require('./helpers/stubBotGateway');

jest.mock('../src/utils/ledger', () => ({
    fetchTransactions: jest.fn(),
    fetchOwedPayouts: jest.fn(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
}));

const { fetchTransactions, fetchOwedPayouts } = require('../src/utils/ledger');

function appWith(resolveUsers = async () => ({})) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = { id: 'admin-1', guilds: [{ id: 'g1', permissions: '8' }] };
        req.bot = stubBotGateway({
            hasGuild: async () => true,
            canManageGuild: async () => true,
            resolveUsers,
        });
        next();
    });
    app.use('/api/v1', require('../src/dashboard/routes/api/members'));
    return app;
}

const USER = '111111111111111111';
const OTHER = '222222222222222222';

beforeEach(() => {
    jest.clearAllMocks();
    require('../src/dashboard/lib/permissions').forgetLiveGuildAccess?.();
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('GET member ledger', () => {
    test('answers with the list envelope, owed payouts attached alongside', async () => {
        fetchTransactions.mockResolvedValue({
            items: [{ _id: 't1', type: 'gift_receive', amount: 500, balance: 1500, bank: null, note: 'Coin gift', relatedUserId: OTHER, createdAt: new Date('2026-02-01') }],
            total: 1, page: 1,
        });
        fetchOwedPayouts.mockResolvedValue([{ id: 'o1', status: 'exhausted', kind: 'coins', amount: 500, payoutKey: 'k1' }]);
        const app = appWith(async () => ({ [OTHER]: { tag: 'bob#0002', avatarUrl: null } }));

        const res = await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger`);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ page: 1, limit: 20, total: 1, pages: 1 });
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0]).toMatchObject({
            id: 't1', type: 'gift_receive', amount: 500, balance: 1500,
            relatedUserId: OTHER, relatedUserTag: 'bob#0002',
        });
        expect(res.body.owed).toEqual([{ id: 'o1', status: 'exhausted', kind: 'coins', amount: 500, payoutKey: 'k1' }]);
    });

    test('scopes both reads to the member and guild in the path', async () => {
        fetchTransactions.mockResolvedValue({ items: [], total: 0, page: 1 });
        fetchOwedPayouts.mockResolvedValue([]);
        const app = appWith();

        await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger`);

        expect(fetchTransactions).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, guildId: 'g1', pageSize: 20 }));
        expect(fetchOwedPayouts).toHaveBeenCalledWith({ userId: USER, guildId: 'g1' });
    });

    test('pages by number derived from the shared page/limit parser', async () => {
        fetchTransactions.mockResolvedValue({ items: [], total: 200, page: 3 });
        fetchOwedPayouts.mockResolvedValue([]);
        const app = appWith();

        await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger?page=3&limit=20`);

        expect(fetchTransactions).toHaveBeenCalledWith(expect.objectContaining({ page: 3, pageSize: 20 }));
    });

    // The route must report the page the ledger actually served, not the raw
    // request: fetchTransactions clamps an out-of-range page, and the envelope
    // has to agree with the rows it returned.
    test('reports the clamped page, not the raw request page', async () => {
        fetchTransactions.mockResolvedValue({ items: [{ _id: 't1', type: 'daily', amount: 1, balance: 1, createdAt: new Date() }], total: 25, page: 3 });
        fetchOwedPayouts.mockResolvedValue([]);
        const app = appWith();

        const res = await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger?page=999&limit=10`);

        expect(res.body.page).toBe(3);
    });

    test('caps the page size a caller can ask for', async () => {
        fetchTransactions.mockResolvedValue({ items: [], total: 0, page: 1 });
        fetchOwedPayouts.mockResolvedValue([]);
        const app = appWith();

        const res = await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger?limit=100000`);

        expect(res.body.limit).toBe(50);
        expect(fetchTransactions).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 50 }));
    });

    test('rejects a malformed user id before touching the ledger', async () => {
        const app = appWith();

        const res = await request(app).get('/api/v1/guild/g1/members/not-an-id/ledger');

        expect(res.status).toBe(400);
        expect(fetchTransactions).not.toHaveBeenCalled();
        expect(fetchOwedPayouts).not.toHaveBeenCalled();
    });

    test('does not resolve a counterparty when no transaction has one', async () => {
        fetchTransactions.mockResolvedValue({
            items: [{ _id: 't1', type: 'daily', amount: 100, balance: 100, relatedUserId: null, createdAt: new Date() }],
            total: 1,
        });
        fetchOwedPayouts.mockResolvedValue([]);
        const resolveUsers = jest.fn(async () => ({}));
        const app = appWith(resolveUsers);

        const res = await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger`);

        expect(resolveUsers).not.toHaveBeenCalled();
        expect(res.body.items[0].relatedUserTag).toBeNull();
    });

    test('surfaces a query failure as a 500, not a crash', async () => {
        fetchTransactions.mockRejectedValue(new Error('mongo is down'));
        fetchOwedPayouts.mockResolvedValue([]);
        const app = appWith();

        const res = await request(app).get(`/api/v1/guild/g1/members/${USER}/ledger`);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});
