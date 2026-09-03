'use strict';

// #925: the two admin adjust routes accepted any integer. `1e20` satisfies
// `Number.isInteger`, so it went straight into `$inc` — and past
// `Number.MAX_SAFE_INTEGER` the arithmetic, the balance and the amounts the
// Transaction ledger records all stop being exact, silently, with nothing at
// any layer reporting a problem. It takes an admin typing an absurd number, but
// the values are awkward to unwind once they are in.
//
// Two halves have to hold together, so both are driven through the real routers
// against a fake User collection that applies the update it is handed: the
// request is refused above the ceiling, and the update the route does issue
// clamps rather than trusting the number it was given — a read-then-write
// clamp would let two admins adjusting at once step over it.
//
// The routes also grew `updatePipeline: true` here, which is not decoration:
// Mongoose 9 throws on a pipeline update without it, so `take` on either route
// was answering 500 to every call.

const express = require('express');
const request = require('supertest');
const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, bank: 0, xp: 0, level: 0 });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/models/GuildAnalytics', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1', username: 'admin' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../src/dashboard/lib/apiHelpers', () => ({
    ...jest.requireActual('../src/dashboard/lib/apiHelpers'),
    logAuditEvent: jest.fn(async () => {}),
}));

const { logAuditEvent, MAX_ADJUST_AMOUNT, MAX_ADJUST_TOTAL } = require('../src/dashboard/lib/apiHelpers');
const economy = require('../src/dashboard/routes/api/economy');
const leveling = require('../src/dashboard/routes/api/leveling');

const GUILD = '999888777666555444';
const USER  = '111222333444555666';

let app;
let errors;

beforeEach(() => {
    jest.clearAllMocks();
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();

    app = express();
    app.use(express.json());
    app.use('/api/v1', economy);
    app.use('/api/v1', leveling);
});

afterEach(() => errors.mockRestore());

const adjustEconomy = body => request(app).post(`/api/v1/guild/${GUILD}/economy/adjust`).send(body);
const adjustLeveling = body => request(app).post(`/api/v1/guild/${GUILD}/leveling/adjust`).send(body);

describe('the ceilings themselves', () => {
    // The clamp's own arithmetic has to be exact, or the ceiling is a rounded
    // number pretending to be one: the largest give applied to a field already
    // at the total is the biggest value the routes can ever compute.
    test('a maximum give onto a maxed-out balance is still an exact integer', () => {
        expect(Number.isSafeInteger(MAX_ADJUST_TOTAL + MAX_ADJUST_AMOUNT)).toBe(true);
        expect(MAX_ADJUST_AMOUNT).toBeLessThan(MAX_ADJUST_TOTAL);
    });
});

describe('POST economy/adjust', () => {
    test('refuses an amount past the safe-integer range and writes nothing', async () => {
        const res = await adjustEconomy({ userId: USER, action: 'give', amount: 1e20 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/integer/);
        expect(mockUsers.writes).toEqual([]);
        expect(logAuditEvent).not.toHaveBeenCalled();
    });

    test('refuses an amount over the per-adjustment ceiling', async () => {
        const res = await adjustEconomy({ userId: USER, action: 'give', amount: MAX_ADJUST_AMOUNT + 1 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at most/);
        expect(mockUsers.writes).toEqual([]);
    });

    test.each([0, -5, 1.5, 'lots', null, undefined, '', '   ', [], true])('refuses %p', async amount => {
        const res = await adjustEconomy({ userId: USER, action: 'give', amount });

        expect(res.status).toBe(400);
        expect(mockUsers.writes).toEqual([]);
    });

    test('an ordinary give still credits the member', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 500 });

        const res = await adjustEconomy({ userId: USER, action: 'give', amount: 250 });

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(750);
        expect(mockUsers.get(USER).balance).toBe(750);
        expect(logAuditEvent).toHaveBeenCalledWith(
            expect.anything(), GUILD, 'economy_adjust',
            { targetUserId: USER, action: 'give', amount: 250 },
        );
    });

    // The ceiling is enforced by the update, not by the validator: a member
    // already at the top takes a legal give and stays exactly representable.
    test('a legal give onto a maxed-out balance clamps instead of drifting', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: MAX_ADJUST_TOTAL });

        const res = await adjustEconomy({ userId: USER, action: 'give', amount: MAX_ADJUST_AMOUNT });

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(MAX_ADJUST_TOTAL);
        expect(Number.isSafeInteger(mockUsers.get(USER).balance)).toBe(true);
    });

    test('repeated maximum gives never climb past the ceiling', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 0 });

        for (let i = 0; i < 4; i++) {
            await adjustEconomy({ userId: USER, action: 'give', amount: MAX_ADJUST_AMOUNT });
        }

        expect(mockUsers.get(USER).balance).toBe(4 * MAX_ADJUST_AMOUNT);
        expect(Number.isSafeInteger(mockUsers.get(USER).balance)).toBe(true);
    });

    // A balance written before the field had a default is missing, not 0, and
    // `$add` over a missing field is null in Mongo — a give would have wiped it.
    test('a document with no balance field is credited rather than nulled', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: undefined });
        delete mockUsers.get(USER).balance;

        const res = await adjustEconomy({ userId: USER, action: 'give', amount: 100 });

        expect(res.status).toBe(200);
        expect(mockUsers.get(USER).balance).toBe(100);
    });

    // Mongoose 9 throws on a pipeline update that has not opted in, so this
    // path answered 500 for every take until the option was added.
    test('take runs, and clamps at zero rather than going negative', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, balance: 100 });

        const res = await adjustEconomy({ userId: USER, action: 'take', amount: 500 });

        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(0);
        expect(mockUsers.get(USER).balance).toBe(0);
    });

    test('a member with no record is a 404, not a row to create', async () => {
        const res = await adjustEconomy({ userId: USER, action: 'give', amount: 10 });

        expect(res.status).toBe(404);
        expect(mockUsers.all()).toEqual([]);
    });
});

describe('POST leveling/adjust', () => {
    test('refuses XP past the safe-integer range', async () => {
        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 1e20 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/integer/);
        expect(mockUsers.writes).toEqual([]);
    });

    // An XP total is spent one level at a time by applyXpGain's catch-up loop
    // (src/services/levelingService.js), so an unbounded grant is an unbounded
    // loop on the member's next message, not merely an inexact number.
    test('refuses XP over the per-adjustment ceiling', async () => {
        const res = await adjustLeveling({ userId: USER, action: 'give', amount: MAX_ADJUST_AMOUNT + 1 });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at most/);
    });

    test('an ordinary XP give still credits the member', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 60 });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, level: 2, xp: 100 });
        // Level 2 needs 300 to advance, so nothing was folded — and the settle
        // step wrote nothing rather than rewriting the pair it was handed.
        expect(mockUsers.writes).toHaveLength(1);
    });

    // #924: `give` moved XP and left `level` alone, so the member kept their old
    // rank — the leaderboard sorts by `{ level: -1, xp: -1 }` — until they next
    // happened to send a message and applyXpGain caught the levels up.
    test('a give that crosses thresholds levels the member up in the same request', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });

        // 40 + 660 = 700, which buys level 2 → 3 (300) and 3 → 4 (400) exactly.
        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 660 });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, level: 4, xp: 0 });
        expect(mockUsers.get(USER)).toMatchObject({ level: 4, xp: 0 });
    });

    test('a give onto a maxed-out XP total clamps, then spends the clamped total', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: MAX_ADJUST_TOTAL, level: 0 });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: MAX_ADJUST_AMOUNT });

        // The clamp still bites — the ceiling is what bounds the catch-up — and
        // the ceiling's worth of XP is then folded into levels rather than left
        // sitting in `xp` as a total no level reflects. XP is progress within a
        // level, so what is conserved is the cumulative cost of getting there.
        const { level, xp } = mockUsers.get(USER);
        expect(50 * level * (level + 1) + xp).toBe(MAX_ADJUST_TOTAL);
        expect(res.body).toEqual({ success: true, level, xp });
        expect(Number.isSafeInteger(xp)).toBe(true);
        expect(Number.isSafeInteger(level)).toBe(true);
    });

    // The settle is a second write, so it is guarded on the XP it was computed
    // from: a concurrent adjustment must lose the guard rather than have a level
    // derived from a total that is no longer the member's written over it.
    test('the level settle is guarded on the XP it was derived from', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });

        await adjustLeveling({ userId: USER, action: 'give', amount: 660 });

        const settle = mockUsers.writes.at(-1);
        expect(settle.op).toBe('findOneAndUpdate');
        // The whole pair, not the XP alone — see the ABA test below.
        expect(settle.query).toMatchObject({ userId: USER, guildId: GUILD, level: 2, xp: 700 });
        expect(settle.update).toEqual({ $set: { level: 4, xp: 0 } });
    });

    /**
     * Lets a test land a write between the adjustment and the settle that
     * follows it. `mutate` runs just before the guarded settle write — the one
     * whose filter names an XP — so the guard is evaluated against a document
     * that has moved underneath it, which is the race the guard exists for.
     */
    function concurrentlyWriteBeforeSettle(mutate, { times = Infinity } = {}) {
        const real = mockUsers.model.findOneAndUpdate.getMockImplementation();
        let landed = 0;
        mockUsers.model.findOneAndUpdate.mockImplementation(async (query, update, options) => {
            if ('xp' in query && landed < times) {
                landed += 1;
                mutate();
            }
            return real(query, update, options);
        });
        return () => mockUsers.model.findOneAndUpdate.mockImplementation(real);
    }

    test('a settle that loses the guard reports the pair the other writer left', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });
        // One interloper, then the retry sees a consistent pair and stops.
        const restore = concurrentlyWriteBeforeSettle(() => { mockUsers.get(USER).xp = 55; }, { times: 1 });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 660 });
        restore();

        // The level derived from 700 XP is not written over the 55 the other
        // writer left, and the response describes the document as it stands.
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, level: 2, xp: 55 });
        expect(mockUsers.get(USER)).toMatchObject({ level: 2, xp: 55 });
    });

    // CodeRabbit on #977: the guard named only `xp`, so it was an ABA check. A
    // level set between the adjustment and its settle moves `level` while a
    // following give can put `xp` back to the very value the settle was computed
    // from — and the settle then wrote a level derived from the *old* level over
    // the new one.
    test('a settle does not overwrite a level set while it was in flight', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });
        // Between the give's write and its settle: set_level 7 (which zeroes XP)
        // and a further give that lands XP back on 300, the value the in-flight
        // settle read.
        const restore = concurrentlyWriteBeforeSettle(() => {
            Object.assign(mockUsers.get(USER), { level: 7, xp: 300 });
        }, { times: 1 });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 260 });
        restore();

        // Level 7 survives: the settle computed level 3 from the pair it read,
        // and that pair is no longer the member's.
        expect(mockUsers.get(USER).level).toBe(7);
        expect(res.status).toBe(200);
    });

    // CodeRabbit on #977: giving up used to answer a plain success carrying
    // whatever the last re-read held — which can be XP still past its threshold,
    // i.e. a rank the database does not hold, reported as final.
    test('a settle that keeps losing the guard says so instead of claiming success', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });
        // Every attempt is beaten, and each interloper leaves XP unsettled.
        let n = 0;
        const restore = concurrentlyWriteBeforeSettle(() => { mockUsers.get(USER).xp = 1000 + (n += 1); });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 660 });
        restore();

        // Not a 4xx: the XP moved and is durable, so inviting a retry would
        // invite a second grant. The response says the level has not caught up.
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, settled: false });
        // Every attempt lost its guard, so no settle write landed.
        expect(mockUsers.writes.filter(write => 'xp' in write.query)).toEqual([]);
        expect(n).toBe(5);
    });

    test('an ordinary settled response does not carry the settled flag', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 40, level: 2 });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: 660 });

        expect(res.body).toEqual({ success: true, level: 4, xp: 0 });
    });

    test('take runs, and clamps at zero', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: 30 });

        const res = await adjustLeveling({ userId: USER, action: 'take', amount: 500 });

        expect(res.status).toBe(200);
        expect(res.body.xp).toBe(0);
    });

    test('refuses a level past the safe-integer range, and one below zero', async () => {
        const tooBig = await adjustLeveling({ userId: USER, action: 'set_level', amount: 1e20 });
        const negative = await adjustLeveling({ userId: USER, action: 'set_level', amount: -1 });

        expect(tooBig.status).toBe(400);
        expect(tooBig.body.error).toMatch(/^level /);
        expect(negative.status).toBe(400);
        expect(mockUsers.writes).toEqual([]);
    });

    // `Number(null)`, `Number('')` and `Number([])` are all 0, and set_level's
    // minimum is 0 — so before the input was type-checked, a request that named
    // no amount at all wiped the member's level instead of being refused.
    test.each([null, undefined, '', '  ', []])('refuses set_level with %p rather than setting level 0', async amount => {
        mockUsers.seed({ userId: USER, guildId: GUILD, level: 9 });

        const res = await adjustLeveling({ userId: USER, action: 'set_level', amount });

        expect(res.status).toBe(400);
        expect(mockUsers.get(USER).level).toBe(9);
        expect(mockUsers.writes).toEqual([]);
    });

    test('set_level still accepts a level, including zero', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, level: 9 });

        const res = await adjustLeveling({ userId: USER, action: 'set_level', amount: 0 });

        expect(res.status).toBe(200);
        expect(mockUsers.get(USER).level).toBe(0);
    });

    // #924: setting a level left the old XP in place. XP is progress *within*
    // the current level, so a level set beneath a large XP balance was undone by
    // the member's next message, which re-derived the level the XP implied.
    test('set_level puts the member at the start of that level', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, level: 2, xp: 250 });

        const res = await adjustLeveling({ userId: USER, action: 'set_level', amount: 7 });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, level: 7, xp: 0 });
        expect(mockUsers.get(USER)).toMatchObject({ level: 7, xp: 0 });
    });
});
