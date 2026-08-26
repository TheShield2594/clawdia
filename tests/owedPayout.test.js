'use strict';

/**
 * #804. Two scheduled jobs claim a record before paying out, and the claim is
 * one-way: once it is spent, re-running the job finds nothing. So a credit that
 * fails afterwards has to be written down per entry, with enough in the payload
 * to pay it later — that is what this module is, and what `retryJob` replays.
 */

jest.mock('../src/models/FailedJob', () => ({ create: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/inventoryGrant', () => ({ grantInventoryItem: jest.fn() }));

const FailedJob = require('../src/models/FailedJob');
const User = require('../src/models/User');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const {
    recordOwedPayout, replayOwedPayout, describeOwedPayout, isOwedPayout, OWED_SUFFIX,
} = require('../src/utils/owedPayout');

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    FailedJob.create.mockResolvedValue({});
    User.findOneAndUpdate.mockResolvedValue({});
    grantInventoryItem.mockResolvedValue({});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorLog.mockRestore());

describe('recordOwedPayout', () => {
    test('files a dead-letter entry carrying everything the credit needs', async () => {
        const error = new Error('mongo down');

        await expect(recordOwedPayout({
            service: 'schedulerService',
            jobName: 'announceHourlyWinners',
            guildId: 'g1',
            payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 },
            error,
        })).resolves.toBe(true);

        expect(FailedJob.create).toHaveBeenCalledWith(expect.objectContaining({
            service: 'schedulerService',
            guildId: 'g1',
            payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 },
            errorMessage: 'mongo down',
            errorStack: error.stack,
        }));
    });

    // runJob files its own entry under the bare job name when the sweep throws.
    // That one says "this run failed"; this one says "this player is owed 500
    // coins", and the replay script has to be able to tell them apart.
    test('suffixes the job name so the run-level entry is distinguishable', async () => {
        await recordOwedPayout({
            service: 'schedulerService', jobName: 'returnExpiredMarketListings',
            payload: { kind: 'items' }, error: new Error('x'),
        });

        const [{ jobName }] = FailedJob.create.mock.calls[0];
        expect(jobName).toBe(`returnExpiredMarketListings${OWED_SUFFIX}`);
        expect(isOwedPayout({ jobName })).toBe(true);
        expect(isOwedPayout({ jobName: 'returnExpiredMarketListings' })).toBe(false);
    });

    // The database being unreachable is the usual reason a payout failed, and
    // the same reason writing it down can fail. The caller has already lost the
    // credit; it must not also lose the rest of its sweep to the bookkeeping.
    test('a queue write that itself fails is reported, not thrown', async () => {
        FailedJob.create.mockRejectedValue(new Error('also down'));

        await expect(recordOwedPayout({
            service: 'schedulerService', jobName: 'announceHourlyWinners',
            payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 },
            error: new Error('mongo down'),
        })).resolves.toBe(false);

        expect(errorLog.mock.calls.flat().join(' ')).toContain('also down');
    });

    test('an error with no message still files a usable entry', async () => {
        await recordOwedPayout({ service: 's', jobName: 'j', payload: {}, error: null });

        expect(FailedJob.create).toHaveBeenCalledWith(expect.objectContaining({
            errorMessage: 'unknown error', errorStack: null, guildId: null,
        }));
    });
});

describe('replayOwedPayout', () => {
    test('credits the coins a winner was owed', async () => {
        await replayOwedPayout({ kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 });

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' },
            { $inc: { balance: 500 } },
        );
    });

    // retryJob reads a return as "paid". `findOneAndUpdate` without `upsert`
    // resolves to null rather than throwing when nothing matches — which is the
    // exact silence this whole mechanism exists to end, so it has to throw here.
    test('a credit that matches no user document throws rather than reporting success', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);

        await expect(replayOwedPayout({ kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 }))
            .rejects.toThrow('no user document for u1 in g1');
    });

    test('returns the items a seller was owed', async () => {
        await replayOwedPayout({ kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword', quantity: 2 });

        expect(grantInventoryItem).toHaveBeenCalledWith('u1', 'g1', 'sword', 2, { upsert: true });
    });

    test('an item grant that fails leaves the record owed', async () => {
        grantInventoryItem.mockRejectedValue(new Error('still down'));

        await expect(replayOwedPayout({ kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword', quantity: 2 }))
            .rejects.toThrow('still down');
    });

    // A payload written by an older build, or hand-edited in the queue. Paying
    // out from an incomplete one would credit the wrong amount to nobody.
    test.each([
        ['coins with no user',    { kind: 'coins', guildId: 'g1', amount: 500 }],
        ['coins with no amount',  { kind: 'coins', userId: 'u1', guildId: 'g1' }],
        ['coins with a zero amount', { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 0 }],
        ['items with no itemId',  { kind: 'items', userId: 'u1', guildId: 'g1', quantity: 2 }],
        ['items with no quantity', { kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword' }],
    ])('refuses to pay from an incomplete payload: %s', async (_label, payload) => {
        await expect(replayOwedPayout(payload)).rejects.toThrow('incomplete');
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(grantInventoryItem).not.toHaveBeenCalled();
    });

    test.each([
        ['an unknown kind', { kind: 'gems', userId: 'u1' }],
        ['no kind at all',  { userId: 'u1' }],
        ['nothing',         undefined],
    ])('refuses %s', async (_label, payload) => {
        await expect(replayOwedPayout(payload)).rejects.toThrow('unknown owed payout kind');
    });
});

describe('describeOwedPayout', () => {
    test('names who is owed what', () => {
        expect(describeOwedPayout({ kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 }))
            .toBe('500 coins to u1 in g1');
        expect(describeOwedPayout({ kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword', quantity: 2 }))
            .toBe('2x sword to u1 in g1');
    });

    test('falls back to the raw payload rather than saying nothing', () => {
        expect(describeOwedPayout({ kind: 'gems', n: 1 })).toBe('{"kind":"gems","n":1}');
    });
});
