'use strict';

// #582/#583/#584. Three things that were only ever true by convention, and so
// were not true everywhere:
//
//   * every response is a JSON object, never a bare array;
//   * a list is `{ items, page, limit, total, pages }`, one key name for every
//     endpoint, and it can actually be paged through;
//   * an admin adjusting a member who has no record gets a 404, not a
//     silently created phantom document.
//
// The route tests drive real Express routers with the models stubbed, so what
// is asserted is the query the route issues and the body it writes — not a
// description of either. The convention test reads the routers as source,
// because the point of it is to catch the *next* route, which by definition has
// no test of its own yet.

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { readPage, pageEnvelope } = require('../src/dashboard/lib/apiPage');
const stubBotGateway = require('./helpers/stubBotGateway');

const API_DIR = path.join(__dirname, '..', 'src', 'dashboard', 'routes', 'api');

// ── The helper ──────────────────────────────────────────────────────────────

describe('readPage', () => {
    const read = (query, opts) => readPage({ query }, opts);

    test('defaults to the first page at the endpoint\'s own size', () => {
        expect(read({}, { defaultLimit: 25 })).toEqual({ page: 1, limit: 25, skip: 0 });
    });

    test('skips by page, not by item', () => {
        expect(read({ page: '3' }, { defaultLimit: 20 })).toEqual({ page: 3, limit: 20, skip: 40 });
    });

    test('clamps an oversized limit to the endpoint maximum rather than 400ing', () => {
        expect(read({ limit: '500' }, { defaultLimit: 20, maxLimit: 50 }).limit).toBe(50);
    });

    // A page of zero rows is an infinite pager, and a negative skip is a Mongo
    // error — both were reachable from the query string before this was one
    // shared function.
    test.each([
        ['zero', { page: '0', limit: '0' }],
        ['negative', { page: '-5', limit: '-5' }],
        ['not a number', { page: 'abc', limit: 'abc' }],
        ['an array, as Express parses ?page=1&page=2', { page: ['1', '2'], limit: ['1', '2'] }],
    ])('refuses a %s page or limit and falls back to the first page', (_label, query) => {
        const { page, limit, skip } = read(query, { defaultLimit: 20, maxLimit: 50 });
        expect(page).toBeGreaterThanOrEqual(1);
        expect(limit).toBeGreaterThanOrEqual(1);
        expect(skip).toBeGreaterThanOrEqual(0);
    });

    test('survives a request with no query object at all', () => {
        expect(readPage(undefined, { defaultLimit: 10 })).toEqual({ page: 1, limit: 10, skip: 0 });
    });
});

describe('pageEnvelope', () => {
    test('reports the number of pages the total actually spans', () => {
        expect(pageEnvelope({ items: [], total: 101, page: 1, limit: 25 }).pages).toBe(5);
    });

    // "Page 1 of 0" is what a pager renders as a broken control. An empty
    // collection still has a first page, and it is the one being looked at.
    test('an empty collection is one page, not zero', () => {
        expect(pageEnvelope({ items: [], total: 0, page: 1, limit: 25 })).toEqual({
            items: [], page: 1, limit: 25, total: 0, pages: 1,
        });
    });
});

// ── The convention, across every router ─────────────────────────────────────

// An array body cannot grow a field later without breaking every caller at
// once, which is exactly how the knowledge base list ended up with a hard
// `.limit(100)` and nowhere to put a cursor (#583).
//
// This is a source scan, because its job is to catch the *next* route — the one
// that by definition has no test of its own yet. It reads a router three ways:
//
//   res.json([ … ])          an array literal
//   res.json(xs.map(…))      a mapped array
//   res.json(entries)        an identifier this file assigned from a query,
//                            an array literal, or a .map/.filter/.slice
//
// The third is the one that matters: `const entries = await Model.find(…)`
// followed by `res.json(entries)` is precisely how both of the bare-array
// endpoints in #582 were written, and a check that only looked for a `[` on the
// res.json line would have passed them both.
//
// It is a syntactic backstop, not a proof — an array reached through a helper
// several files away is beyond it. The per-route tests below are what actually
// pin the bodies the endpoints in the issue return.
function bareArrayOffenders(label, source) {
    const lines = source.split('\n');

    // Identifiers this file binds to something array-shaped.
    const arrayBound = new Set();
    const BINDING = /(?:const|let|var)\s+(\w+)\s*=\s*(await\s+)?(.+)$/;
    for (const line of lines) {
        const m = line.match(BINDING);
        if (!m) continue;
        const [, name, , rhs] = m;
        if (/^\[/.test(rhs) || /\.(find|map|filter|slice|concat|sort)\(/.test(rhs)) {
            arrayBound.add(name);
        }
    }

    const offenders = [];
    lines.forEach((line, i) => {
        const call = line.match(/res\.json\(\s*([^)]*)/);
        if (!call) return;
        const arg = call[1].trim();
        const isLiteralArray = arg.startsWith('[');
        const isMapped = /^\w+\.map\(/.test(arg);
        const isArrayBoundIdent = /^\w+$/.test(arg) && arrayBound.has(arg);
        if (isLiteralArray || isMapped || isArrayBoundIdent) {
            offenders.push(`${label}:${i + 1}  ${line.trim()}`);
        }
    });
    return offenders;
}

describe('no router answers with a bare array', () => {
    const files = fs.readdirSync(API_DIR).filter(f => f.endsWith('.js'));

    test.each(files)('%s', file => {
        const source = fs.readFileSync(path.join(API_DIR, file), 'utf8');
        expect(bareArrayOffenders(file, source)).toEqual([]);
    });

    // The scan is only worth having if it fails on the code it was written
    // for, so here is that code — both bare-array shapes #582 named, checked
    // against a throwaway router rather than described in a comment.
    test('catches the two shapes the issue was filed about', () => {
        const offenders = bareArrayOffenders('probe.js', [
            "router.get('/a', async (req, res) => {",
            '    const entries = await KnowledgeBase.find({ guildId }).sort({ createdAt: -1 }).limit(100);',
            '    res.json(entries);',
            '});',
            "router.get('/b', (req, res) => res.json([]));",
        ].join('\n'));

        expect(offenders).toHaveLength(2);
        expect(offenders[0]).toContain('res.json(entries)');
        expect(offenders[1]).toContain('res.json([])');
    });

    // …and it must not fire on the object bodies the convention allows, or the
    // next author will delete it rather than satisfy it.
    test('leaves the object shapes the convention allows alone', () => {
        expect(bareArrayOffenders('probe.js', [
            "router.get('/a', async (req, res) => {",
            '    const items = await KnowledgeBase.find({ guildId });',
            '    res.json(pageEnvelope({ items, total, page, limit }));',
            '});',
            "router.get('/b', (req, res) => res.json({ items: [] }));",
            "router.get('/c', (req, res) => res.json({ success: true }));",
            "router.get('/d', (req, res) => res.json(settings.ai?.dailyDigest || {}));",
        ].join('\n'))).toEqual([]);
    });
});

// ── The routes themselves ───────────────────────────────────────────────────

jest.mock('../src/models/KnowledgeBase');
jest.mock('../src/models/SummaryJob');
jest.mock('../src/models/User');
jest.mock('../src/dashboard/lib/aggregateCache', () => ({
    cachedAggregate: jest.fn(),
    invalidatePrefix: jest.fn(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const KnowledgeBase = require('../src/models/KnowledgeBase');
const SummaryJob = require('../src/models/SummaryJob');
const User = require('../src/models/User');

// A chainable Mongoose query stub that resolves to `rows`. The routes call
// .sort().skip().limit() — asserting on the calls is how the pagination is
// checked at all, since a stub cannot slice anything itself.
function query(rows) {
    const q = {
        sort: jest.fn(() => q),
        skip: jest.fn(() => q),
        limit: jest.fn(() => q),
        select: jest.fn(() => q),
        lean: jest.fn(() => q),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
}

// The routers are mounted behind stub auth: checkAuth and checkGuildAccess have
// their own tests, and nothing here is about them.
function appWith(routerPath) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = { id: 'admin-1', guilds: [{ id: 'g1', permissions: '8' }] };
        req.bot = stubBotGateway({
            hasGuild: async () => true,
            canManageGuild: async () => true,
            resolveUsers: async () => ({}),
        });
        next();
    });
    app.use('/api/v1', require(routerPath));
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    require('../src/dashboard/lib/permissions').forgetLiveGuildAccess?.();
});

describe('GET knowledge-base', () => {
    const app = appWith('../src/dashboard/routes/api/knowledgeBase');

    test('answers with the list envelope, not a bare array', async () => {
        KnowledgeBase.find.mockReturnValue(query([{ title: 'Rules' }]));
        KnowledgeBase.countDocuments.mockResolvedValue(1);

        const res = await request(app).get('/api/v1/guild/g1/knowledge-base');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            items: [{ title: 'Rules' }], page: 1, limit: 25, total: 1, pages: 1,
        });
    });

    // The bug in #583: entry 101 was not on a later page, it was unreachable —
    // and so was unremovable through the dashboard that lists it.
    test('reaches past the hundredth entry, which the old hard limit could not', async () => {
        const q = query([]);
        KnowledgeBase.find.mockReturnValue(q);
        KnowledgeBase.countDocuments.mockResolvedValue(400);

        const res = await request(app).get('/api/v1/guild/g1/knowledge-base?page=5');

        expect(q.skip).toHaveBeenCalledWith(100);
        expect(q.limit).toHaveBeenCalledWith(25);
        expect(res.body.pages).toBe(16);
        expect(res.body.total).toBe(400);
    });

    test('caps the page size a caller can ask for', async () => {
        const q = query([]);
        KnowledgeBase.find.mockReturnValue(q);
        KnowledgeBase.countDocuments.mockResolvedValue(0);

        await request(app).get('/api/v1/guild/g1/knowledge-base?limit=100000');

        expect(q.limit).toHaveBeenCalledWith(100);
    });

    test('an empty knowledge base is still one page', async () => {
        KnowledgeBase.find.mockReturnValue(query([]));
        KnowledgeBase.countDocuments.mockResolvedValue(0);

        const res = await request(app).get('/api/v1/guild/g1/knowledge-base');

        expect(res.body).toEqual({ items: [], page: 1, limit: 25, total: 0, pages: 1 });
    });

    test('scopes both the page and the count to the guild in the path', async () => {
        KnowledgeBase.find.mockReturnValue(query([]));
        KnowledgeBase.countDocuments.mockResolvedValue(0);

        await request(app).get('/api/v1/guild/g1/knowledge-base');

        expect(KnowledgeBase.find).toHaveBeenCalledWith({ guildId: 'g1' });
        expect(KnowledgeBase.countDocuments).toHaveBeenCalledWith({ guildId: 'g1' });
    });
});

describe('GET summary-jobs', () => {
    const app = appWith('../src/dashboard/routes/api/summaryJobs');

    test('answers with the list envelope, not a bare array', async () => {
        SummaryJob.find.mockReturnValue(query([{ label: 'Daily' }]));
        SummaryJob.countDocuments.mockResolvedValue(1);

        const res = await request(app).get('/api/v1/guild/g1/summary-jobs');

        expect(res.body).toEqual({
            items: [{ label: 'Daily' }], page: 1, limit: 10, total: 1, pages: 1,
        });
    });

    // The create route caps a guild at ten, so one request is the whole list —
    // but the read side is bounded now regardless of what that cap becomes.
    test('bounds the query even though the create route caps the collection', async () => {
        const q = query([]);
        SummaryJob.find.mockReturnValue(q);
        SummaryJob.countDocuments.mockResolvedValue(0);

        await request(app).get('/api/v1/guild/g1/summary-jobs');

        expect(q.limit).toHaveBeenCalledWith(10);
        expect(q.skip).toHaveBeenCalledWith(0);
    });
});

describe('admin adjust endpoints no longer upsert (#584)', () => {
    const economy = appWith('../src/dashboard/routes/api/economy');
    const leveling = appWith('../src/dashboard/routes/api/leveling');

    // A snowflake carries no checksum, so a mistyped one is still well-formed
    // and passes validation. Upserting turned that typo into a member document
    // for someone who may not exist, and reported success.
    const MISTYPED = '123456789012345678';

    test('economy adjust 404s instead of creating a phantom member', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);

        const res = await request(economy)
            .post('/api/v1/guild/g1/economy/adjust')
            .send({ userId: MISTYPED, action: 'give', amount: 500 });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no economy record/i);
        // The update itself is a clamped pipeline now (#925) and is asserted in
        // tests/dashboardAdjustLimits.test.js; what belongs here is that it went
        // to the member the request named and did not offer to create one.
        const [filter, , options] = User.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ userId: MISTYPED, guildId: 'g1' });
        expect(options.upsert).toBeUndefined();
    });

    test('leveling adjust 404s instead of creating a phantom member', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);

        const res = await request(leveling)
            .post('/api/v1/guild/g1/leveling/adjust')
            .send({ userId: MISTYPED, action: 'give', amount: 10 });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no leveling record/i);
        const [, , options] = User.findOneAndUpdate.mock.calls[0];
        expect(options.upsert).toBeUndefined();
    });

    test.each(['give', 'take', 'reset', 'freeze', 'unfreeze'])(
        'economy `%s` still adjusts a member who does have a record',
        async action => {
            User.findOneAndUpdate.mockResolvedValue({ balance: 42, bank: 7, economyFrozen: false });

            const res = await request(economy)
                .post('/api/v1/guild/g1/economy/adjust')
                .send({ userId: MISTYPED, action, amount: 5 });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, balance: 42, bank: 7, economyFrozen: false });
        },
    );

    test.each(['give', 'take', 'reset', 'set_level'])(
        'leveling `%s` still adjusts a member who does have a record',
        async action => {
            User.findOneAndUpdate.mockResolvedValue({ level: 3, xp: 250 });

            const res = await request(leveling)
                .post('/api/v1/guild/g1/leveling/adjust')
                .send({ userId: MISTYPED, action, amount: 1 });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, level: 3, xp: 250 });
        },
    );
});
