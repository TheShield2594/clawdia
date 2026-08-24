'use strict';

// #604: /guild/:id/stats is a page-load endpoint. It fanned out five collection
// -wide reads and then walked the guild's command log twice — once for the
// per-command summary, once for the daily volume series — with a nested
// `Object.entries().sort()` per channel on top, and it did all of that again on
// the very next request. The whole payload is now memoised for a minute, and
// what it does compute, it computes in one pass.

const express = require('express');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), exists: jest.fn() }));
jest.mock('../src/models/GuildAnalytics', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ aggregate: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Case', () => ({ find: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const GuildAnalytics = require('../src/models/GuildAnalytics');
const User = require('../src/models/User');
const { __reset, invalidatePrefix } = require('../src/dashboard/lib/aggregateCache');
const statsRouter = require('../src/dashboard/routes/api/stats');

let server;
let baseUrl;

const get = async path => {
    const resp = await fetch(baseUrl + path);
    return { status: resp.status, body: await resp.json() };
};

function stubAnalytics(doc) {
    GuildAnalytics.findOne.mockImplementation(() => ({ lean: async () => doc }));
}

beforeAll(async () => {
    const app = express();
    app.use('/api', statsRouter);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
    jest.clearAllMocks();
    __reset();
    User.find.mockImplementation(() => {
        const chain = {
            select() { return chain; },
            sort() { return chain; },
            limit() { return chain; },
            lean: async () => [],
        };
        return chain;
    });
    User.countDocuments.mockResolvedValue(0);
    User.aggregate.mockResolvedValue([]);
    Guild.findOne.mockImplementation(() => ({ select() { return this; }, lean: async () => ({ guildId: 'g1' }) }));
    stubAnalytics({ guildId: 'g1', memberEvents: [], commandUsage: [] });
});

describe('/stats response cache', () => {
    test('a second request inside the window re-reads nothing', async () => {
        await get('/guild/g1/stats');
        const reads = User.countDocuments.mock.calls.length + User.aggregate.mock.calls.length;
        expect(reads).toBeGreaterThan(0);

        jest.clearAllMocks();
        stubAnalytics({ guildId: 'g1', memberEvents: [], commandUsage: [] });

        const { status, body } = await get('/guild/g1/stats');

        expect(status).toBe(200);
        expect(body.totalUsers).toBe(0);
        expect(User.countDocuments).not.toHaveBeenCalled();
        expect(User.aggregate).not.toHaveBeenCalled();
        expect(GuildAnalytics.findOne).not.toHaveBeenCalled();
    });

    test('concurrent cold requests share one build rather than racing five reads each', async () => {
        const [a, b, c] = await Promise.all([
            get('/guild/g1/stats'), get('/guild/g1/stats'), get('/guild/g1/stats'),
        ]);

        expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
        expect(GuildAnalytics.findOne).toHaveBeenCalledTimes(1);
    });

    test('one guild\'s cached payload is not served to another', async () => {
        await get('/guild/g1/stats');
        User.countDocuments.mockResolvedValue(7);

        const { body } = await get('/guild/g2/stats');

        expect(body.totalUsers).toBe(7);
    });

    test('a write that invalidates the guild drops the payload too', async () => {
        await get('/guild/g1/stats');
        // The shape /economy uses after a balance edit.
        invalidatePrefix('g1:');
        User.countDocuments.mockResolvedValue(4);

        const { body } = await get('/guild/g1/stats');

        expect(body.totalUsers).toBe(4);
    });

    test('a failed build is not cached', async () => {
        GuildAnalytics.findOne.mockImplementation(() => ({ lean: async () => { throw new Error('mongo down'); } }));
        expect((await get('/guild/g1/stats')).status).toBe(500);

        stubAnalytics({ guildId: 'g1', memberEvents: [], commandUsage: [] });

        expect((await get('/guild/g1/stats')).status).toBe(200);
    });
});

describe('/stats command-log aggregation', () => {
    // The volume series is a rolling thirty days ending today, so the fixture is
    // dated relative to the run. Fixed dates would have passed until the day they
    // fell out of the window and then started failing on their own.
    // Resolved once, so the fixture and the assertions cannot land on opposite
    // sides of a UTC midnight that passes mid-test.
    const dayAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const [today, d3, d4] = [dayAgo(0), dayAgo(3), dayAgo(4)];
    const at = (date, hour) => `${date}T${String(hour).padStart(2, '0')}:00:00Z`;

    // Two commands, three channels, and an hour that ties on count so the
    // tie-break is pinned rather than left to whichever hour was seen first.
    const commandUsage = [
        { command: 'ping',  success: true,  channelId: 'c1', hour: 9,  createdAt: at(d4, 9) },
        { command: 'ping',  success: true,  channelId: 'c1', hour: 14, createdAt: at(d4, 14) },
        { command: 'ping',  success: false, channelId: 'c1', hour: 14, reason: 'execution_error', createdAt: at(d3, 14) },
        { command: 'ping',  success: true,  channelId: 'c1', hour: 9,  createdAt: at(d3, 9) },
        { command: 'daily', success: false, channelId: 'c2', hour: 3,  reason: 'cooldown', createdAt: at(d3, 3) },
        { command: 'daily', success: true,                   hour: 3,  createdAt: at(d3, 3) },
    ];

    beforeEach(() => {
        stubAnalytics({
            guildId: 'g1',
            memberEvents: [{ date: today, joins: 5, leaves: 1 }],
            commandUsage,
        });
    });

    test('summarises commands and failure reasons in the single pass', async () => {
        const { body } = await get('/guild/g1/stats');

        expect(body.analytics.commandUsage).toEqual({
            ping:  { total: 4, failed: 1 },
            daily: { total: 2, failed: 1 },
        });
        expect(body.analytics.failedCommands).toEqual({ execution_error: 1, cooldown: 1 });
    });

    test('picks each channel\'s busiest hour, breaking ties toward the earlier one', async () => {
        const { body } = await get('/guild/g1/stats');

        // c1 has hour 9 twice and hour 14 twice — the sort this replaced ran over
        // numerically-ordered keys, so a tie went to hour 9.
        expect(body.analytics.bestPostingTimes).toEqual([
            { channelId: 'c1', hourUtc: 9 },
            { channelId: 'c2', hourUtc: 3 },
            { channelId: 'unknown', hourUtc: 3 },
        ]);
    });

    test('tallies daily volume from the same pass', async () => {
        const { body } = await get('/guild/g1/stats');

        const byDate = Object.fromEntries(body.analytics.messageVolume.map(d => [d.date, d.count]));
        expect(byDate[d4]).toBe(2);
        expect(byDate[d3]).toBe(4);
        expect(body.analytics.messageVolume).toHaveLength(30);
        // Every dated event lands somewhere in the window rather than off its end.
        const total = body.analytics.messageVolume.reduce((sum, d) => sum + d.count, 0);
        expect(total).toBe(commandUsage.length);
    });

    test('reads member growth by date instead of scanning the event log per day', async () => {
        const { body } = await get('/guild/g1/stats');

        expect(body.analytics.memberGrowth).toHaveLength(30);
        expect(body.analytics.memberGrowth.at(-1)).toEqual({ date: today, joins: 5, leaves: 1 });
    });
});
