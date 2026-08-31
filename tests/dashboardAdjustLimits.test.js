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

    test.each([0, -5, 1.5, 'lots', null])('refuses %p', async amount => {
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
    });

    test('a give onto a maxed-out XP total clamps', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, xp: MAX_ADJUST_TOTAL });

        const res = await adjustLeveling({ userId: USER, action: 'give', amount: MAX_ADJUST_AMOUNT });

        expect(res.body.xp).toBe(MAX_ADJUST_TOTAL);
        expect(Number.isSafeInteger(mockUsers.get(USER).xp)).toBe(true);
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

    test('set_level still accepts a level, including zero', async () => {
        mockUsers.seed({ userId: USER, guildId: GUILD, level: 9 });

        const res = await adjustLeveling({ userId: USER, action: 'set_level', amount: 0 });

        expect(res.status).toBe(200);
        expect(mockUsers.get(USER).level).toBe(0);
    });
});
