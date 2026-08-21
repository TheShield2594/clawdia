'use strict';

// /insights loaded every user in the guild — `User.find({ guildId })` with no
// limit — to produce four numbers, then filtered the resulting array four times.
// Beside it, a thousand moderation cases were hydrated as full documents to read
// five fields off each. Neither is a problem in a guild of forty; both are a way
// to spend the container's 1 GB in a guild of forty thousand, and the route had
// no rate limit to make repeating it expensive for the caller.
//
// The counting moved into the pipeline. That is worth testing precisely because
// it is a rewrite of arithmetic that was previously plain JavaScript: the shape
// is cheaper, and it has to still produce the same four numbers.

const express = require('express');
const { evaluate } = require('./helpers/pipelineUpdate');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), exists: jest.fn() }));
jest.mock('../src/models/GuildAnalytics', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ aggregate: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../src/models/Case',  () => ({ find: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const GuildAnalytics = require('../src/models/GuildAnalytics');
const User  = require('../src/models/User');
const Case  = require('../src/models/Case');
const { __reset } = require('../src/dashboard/lib/aggregateCache');
const statsRouter = require('../src/dashboard/routes/api/stats');

let server;
let baseUrl;

// ---------------------------------------------------------------------------
// Just enough of an aggregation runner for the stages this route issues. It
// reuses the shared expression evaluator, which throws on an operator it does
// not know — a pipeline that grows one should fail here rather than quietly
// return a different number.
// ---------------------------------------------------------------------------
function runPipeline(docs, stages) {
    let rows = docs.map(d => ({ ...d }));
    for (const stage of stages) {
        if (stage.$match) {
            rows = rows.filter(row => Object.entries(stage.$match).every(([field, cond]) => {
                if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
                    return Object.entries(cond).every(([op, operand]) => {
                        // Mongo brackets range comparisons by BSON type: a `$lte` against
                        // a date never matches a document whose field is null or absent,
                        // however cheerfully JavaScript would coerce it to zero.
                        if (operand instanceof Date && !(row[field] instanceof Date)) return false;
                        return evaluate({ [op]: [`$${field}`, operand] }, row);
                    });
                }
                return row[field] === cond;
            }));
        } else if (stage.$set || stage.$addFields) {
            const set = stage.$set ?? stage.$addFields;
            rows = rows.map(row => ({
                ...row,
                ...Object.fromEntries(Object.entries(set).map(([k, expr]) => [k, evaluate(expr, row)])),
            }));
        } else if (stage.$group) {
            const { _id, ...accumulators } = stage.$group;
            if (_id !== null) throw new Error('test runner only groups the whole set');
            const out = { _id: null };
            for (const [field, acc] of Object.entries(accumulators)) {
                out[field] = rows.reduce((sum, row) => sum + evaluate(acc.$sum, row), 0);
            }
            rows = rows.length ? [out] : [];
        } else {
            throw new Error(`test runner: unsupported stage ${Object.keys(stage).join(', ')}`);
        }
    }
    return rows;
}

// The array logic /insights used before the rewrite, kept verbatim as the oracle.
function legacyCohorts(docs, now) {
    const cohort7  = docs.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= 7 * 864e5);
    const cohort30 = docs.filter(u => u.createdAt && (now - new Date(u.createdAt).getTime()) >= 30 * 864e5);
    const isConverted = u => (u.messages || 0) >= 20 || (u.level || 0) >= 2;
    return {
        cohort7: cohort7.length,
        converted7: cohort7.filter(isConverted).length,
        cohort30: cohort30.length,
        converted30: cohort30.filter(isConverted).length,
    };
}

const daysAgo = n => new Date(Date.now() - n * 864e5);

// ---------------------------------------------------------------------------

function stubCaseFind(docs = []) {
    const seen = {};
    Case.find.mockImplementation(() => {
        const chain = {
            select(fields) { seen.select = fields; return chain; },
            sort() { return chain; },
            limit(n) { seen.limit = n; return chain; },
            lean() { seen.lean = true; return Promise.resolve(docs); },
        };
        return chain;
    });
    return seen;
}

function stubGuildFindOne(doc) {
    const seen = {};
    Guild.findOne.mockImplementation(() => ({
        select(fields) { seen.select = fields; return this; },
        lean: () => Promise.resolve(doc),
    }));
    return seen;
}

function stubAnalyticsFindOne(doc) {
    const seen = {};
    GuildAnalytics.findOne.mockImplementation(() => ({
        select(fields) { seen.select = fields; return this; },
        lean: () => Promise.resolve(doc),
    }));
    return seen;
}

function stubUserFind(docs = []) {
    User.find.mockImplementation(() => {
        const chain = {
            select() { return chain; },
            sort() { return chain; },
            limit() { return chain; },
            lean() { return Promise.resolve(docs); },
        };
        return chain;
    });
}

const get = async (path) => {
    const resp = await fetch(baseUrl + path);
    return { status: resp.status, body: await resp.json() };
};

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
    stubUserFind([]);
    User.countDocuments.mockResolvedValue(0);
    User.aggregate.mockResolvedValue([]);
    stubGuildFindOne({ guildId: 'g1' });
    Guild.exists.mockResolvedValue({ _id: 'g1' });
    stubAnalyticsFindOne({ guildId: 'g1', memberEvents: [], commandUsage: [] });
    stubCaseFind([]);
});

// ---------------------------------------------------------------------------

describe('/insights newcomer conversion', () => {
    const population = [
        { guildId: 'g1', createdAt: daysAgo(45), messages: 50, level: 1 },  // 30d cohort, converted on messages
        { guildId: 'g1', createdAt: daysAgo(40), messages: 0,  level: 5 },  // 30d cohort, converted on level
        { guildId: 'g1', createdAt: daysAgo(31), messages: 3,  level: 1 },  // 30d cohort, not converted
        { guildId: 'g1', createdAt: daysAgo(10), messages: 20, level: 0 },  // 7d cohort only, converted on the boundary
        { guildId: 'g1', createdAt: daysAgo(8),  messages: 19, level: 1 },  // 7d cohort only, one message short
        { guildId: 'g1', createdAt: daysAgo(2),  messages: 99, level: 9 },  // too new for either cohort
        { guildId: 'g1', createdAt: null,        messages: 99, level: 9 },  // no join date at all
        { guildId: 'g2', createdAt: daysAgo(60), messages: 99, level: 9 },  // another guild entirely
    ];

    beforeEach(() => {
        User.aggregate.mockImplementation(async stages => runPipeline(population, stages));
    });

    test('counts the same four numbers the array filters produced', async () => {
        const expected = legacyCohorts(population.filter(u => u.guildId === 'g1'), Date.now());
        const { body } = await get('/guild/g1/insights');

        expect(body.newcomerConversion.days7).toMatchObject({
            cohortSize: expected.cohort7, converted: expected.converted7,
        });
        expect(body.newcomerConversion.days30).toMatchObject({
            cohortSize: expected.cohort30, converted: expected.converted30,
        });
    });

    test('and those numbers are the ones the fixture was built to produce', async () => {
        const { body } = await get('/guild/g1/insights');

        // Spelled out so a change in the pipeline cannot be rubber-stamped by an
        // oracle that drifted along with it.
        expect(body.newcomerConversion.days7).toEqual({ cohortSize: 5, converted: 3, pct: 60 });
        expect(body.newcomerConversion.days30).toEqual({ cohortSize: 3, converted: 2, pct: 66.7 });
    });

    test('never asks the database for the documents themselves', async () => {
        await get('/guild/g1/insights');

        // The unbounded `User.find({ guildId })` this replaced is the whole point:
        // peak memory grew with the size of the server, to compute four integers.
        expect(User.find).not.toHaveBeenCalled();
        expect(User.aggregate).toHaveBeenCalledTimes(1);
    });

    test('narrows to the wider cohort in the match, not in the process', async () => {
        await get('/guild/g1/insights');

        const [stages] = User.aggregate.mock.calls[0];
        expect(stages[0].$match.guildId).toBe('g1');
        expect(stages[0].$match.createdAt.$lte).toBeInstanceOf(Date);
    });

    test('reports zeroes rather than dividing by an empty cohort', async () => {
        User.aggregate.mockResolvedValue([]);

        const { body } = await get('/guild/g1/insights');

        expect(body.newcomerConversion.days7).toEqual({ cohortSize: 0, converted: 0, pct: 0 });
        expect(body.newcomerConversion.days30).toEqual({ cohortSize: 0, converted: 0, pct: 0 });
    });
});

describe('/insights reads', () => {
    test('takes moderation cases projected and lean, still capped at 1000', async () => {
        const seen = stubCaseFind([]);

        await get('/guild/g1/insights');

        expect(seen.select).toBe('type createdAt resolvedAt evidence.jumpUrl');
        expect(seen.lean).toBe(true);
        expect(seen.limit).toBe(1000);
    });

    test('reads telemetry from GuildAnalytics and only existence from Guild', async () => {
        await get('/guild/g1/insights');

        // Telemetry moved to its own collection — the route never pulls the
        // Guild document (with its shop image Buffers) at all.
        expect(GuildAnalytics.findOne).toHaveBeenCalledWith({ guildId: 'g1' });
        expect(Guild.exists).toHaveBeenCalledWith({ guildId: 'g1' });
        expect(Guild.findOne).not.toHaveBeenCalled();
    });

    test('still 404s a guild that is not there', async () => {
        Guild.exists.mockResolvedValue(null);
        stubAnalyticsFindOne(null);

        const { status } = await get('/guild/nope/insights');

        expect(status).toBe(404);
    });
});

describe('/stats', () => {
    test('runs each collection-wide read once across repeated requests', async () => {
        await get('/guild/g1/stats');
        await get('/guild/g1/stats');

        // Two `$group`s over every user in the guild, a count, and a sort — the cost
        // of the panel is the same whether it is opened once or left refreshing.
        expect(User.aggregate).toHaveBeenCalledTimes(2);   // totalMessages + ecoTotal
        expect(User.countDocuments).toHaveBeenCalledTimes(2); // totalUsers + active
        expect(User.find).toHaveBeenCalledTimes(1);
    });

    test('does not serve one guild the other guild\'s numbers', async () => {
        User.countDocuments.mockResolvedValueOnce(11).mockResolvedValue(0);
        const first = await get('/guild/g1/stats');
        User.countDocuments.mockResolvedValueOnce(22).mockResolvedValue(0);
        const second = await get('/guild/g2/stats');

        expect(first.body.totalUsers).toBe(11);
        expect(second.body.totalUsers).toBe(22);
    });

    test('asks the guild for the fields it reads and not the shop images', async () => {
        const seen = stubGuildFindOne({ guildId: 'g1' });

        await get('/guild/g1/stats');

        expect(seen.select.split(/\s+/)).not.toContain('shop');
        // Telemetry no longer lives on the Guild document at all.
        expect(seen.select.split(/\s+/)).not.toContain('analytics');
        expect(GuildAnalytics.findOne).toHaveBeenCalledWith({ guildId: 'g1' });
    });
});
