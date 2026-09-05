'use strict';

/**
 * #804. Two scheduled jobs claim a record before paying out, and the claim is
 * one-way: once it is spent, re-running the job finds nothing. So a credit that
 * fails afterwards has to be written down per entry, with enough in the payload
 * to pay it later — that is what this module is, and what `retryJob` replays.
 */

jest.mock('../src/models/FailedJob', () => ({ create: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/utils/inventoryGrant', () => ({ grantInventoryItem: jest.fn() }));

const FailedJob = require('../src/models/FailedJob');
const User = require('../src/models/User');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const {
    recordOwedPayout, replayOwedPayout, describeOwedPayout, payoutKeyForPayload, isOwedPayout, OWED_SUFFIX,
} = require('../src/utils/owedPayout');

let errorLog;
let warnLog;
let infoLog;

beforeEach(() => {
    jest.clearAllMocks();
    FailedJob.create.mockResolvedValue({});
    User.findOneAndUpdate.mockResolvedValue({});
    grantInventoryItem.mockResolvedValue({});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnLog  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    infoLog  = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    errorLog.mockRestore();
    warnLog.mockRestore();
    infoLog.mockRestore();
});

describe('recordOwedPayout', () => {
    test('files a dead-letter entry carrying everything the credit needs', async () => {
        const error = new Error('mongo down');

        await expect(recordOwedPayout({
            service: 'weeklyChampionService',
            jobName: 'announceWeeklyChampions',
            guildId: 'g1',
            payload: { kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 },
            error,
        })).resolves.toBe(true);

        expect(FailedJob.create).toHaveBeenCalledWith(expect.objectContaining({
            service: 'weeklyChampionService',
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
            service: 'marketService', jobName: 'returnExpiredMarketListings',
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
            service: 'weeklyChampionService', jobName: 'announceWeeklyChampions',
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

    // #873. The item side's answer to `counters` on the coin side: bookkeeping
    // the original write was going to move alongside the item, so the replay
    // reproduces that write rather than half of it. The difference is that this
    // counter resets every 24 hours, so it is gated on the window it was spent
    // in — inside the same write, so there is no second read and no gap for the
    // window to turn over in.
    test('gates a budget refund on the window it was spent in', async () => {
        const window = new Date('2026-09-05T10:00:00Z');

        await replayOwedPayout({
            kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword', quantity: 2,
            payoutKey: 'gift:i-1:rollback',
            budgetRefund: {
                usedField: 'dailyGiftItemValueSent', resetField: 'dailyGiftItemValueReset',
                cap: 250_000, amount: 200, window,
            },
        });

        const [, , , , options] = grantInventoryItem.mock.calls[0];
        expect(options.extraSet.dailyGiftItemValueSent).toEqual({
            $cond: [
                { $eq: ['$dailyGiftItemValueReset', window] },
                { $max: [0, { $subtract: [{ $ifNull: ['$dailyGiftItemValueSent', 0] }, 200] }] },
                { $ifNull: ['$dailyGiftItemValueSent', 0] },
            ],
        });
    });

    test('replays an item payload with no budget refund exactly as before', async () => {
        await replayOwedPayout({
            kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword', quantity: 2,
            payoutKey: 'listing:l-1',
        });

        const [, , , , options] = grantInventoryItem.mock.calls[0];
        expect(options.extraSet).toEqual({ paidPayouts: expect.anything() });
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

// #807. The replay is where a duplicate payment actually happens: the credit
// that recorded this may have committed and only lost its response. So the
// replay's own credit carries the key, and the two ways it can match nothing —
// already paid, no document — have to stay distinguishable, because one is done
// and the other is still owed.
describe('replayOwedPayout with a payout key', () => {
    const weekly = {
        kind: 'coins', userId: 'u1', guildId: 'g1', amount: 10_000,
        week: '2026-W35', category: 'fish', payoutKey: 'weekly:2026-W35:fish',
    };
    const listing = {
        kind: 'items', userId: 'u1', guildId: 'g1', itemId: 'sword', quantity: 2,
        listingId: 'l1', payoutKey: 'listing:l1',
    };

    /** `User.findOne(...).lean()` resolving to `doc`, for the classification read. */
    function stubRead(doc) {
        User.findOne.mockReturnValue({ lean: async () => doc });
    }

    beforeEach(() => {
        User.findOne = jest.fn();
        stubRead(null);
    });

    test('guards the credit with the key the original attempt used', async () => {
        await replayOwedPayout(weekly);

        const [filter, update] = User.findOneAndUpdate.mock.calls[0];
        expect(filter['paidPayouts.key']).toEqual({ $ne: 'weekly:2026-W35:fish' });
        expect(update[0].$set.balance).toEqual({ $add: [{ $ifNull: ['$balance', 0] }, 10_000] });
    });

    test('a payout already applied moves no coins and is not still owed', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        stubRead({ paidPayouts: [{ key: 'weekly:2026-W35:fish' }] });

        // retryJob reads a return as "paid" and marks the record resolved, which
        // is right: the winner has the coins.
        await expect(replayOwedPayout(weekly)).resolves.toBeUndefined();
    });

    // The other half of the same `null`. Reporting this as paid is exactly the
    // silence #804 closed, so it has to keep throwing.
    test('a payout against a missing user document is still owed', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        stubRead(null);

        await expect(replayOwedPayout(weekly)).rejects.toThrow('no user document for u1 in g1');
    });

    test('a document without the key is retried rather than declared paid', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        stubRead({ paidPayouts: [] });

        await expect(replayOwedPayout(weekly)).rejects.toThrow('matched nothing');
    });

    test('an item return already applied grants nothing', async () => {
        grantInventoryItem.mockResolvedValue(null);
        stubRead({ paidPayouts: [{ key: 'listing:l1' }] });

        await expect(replayOwedPayout(listing)).resolves.toBeUndefined();
        expect(grantInventoryItem).toHaveBeenCalledTimes(1);
    });

    test('an item return still owed guards its grant and its insert', async () => {
        await replayOwedPayout(listing);

        const [, , , , options] = grantInventoryItem.mock.calls[0];
        expect(options.guard).toEqual({ 'paidPayouts.key': { $ne: 'listing:l1' } });
    });

    // Records written before the key existed already carry everything the key is
    // made of, so they replay guarded too rather than staying at-least-once
    // forever.
    test('derives the key for a record written before payoutKey was stored', () => {
        expect(payoutKeyForPayload({ kind: 'coins', week: '2026-W35', category: 'fish' }))
            .toBe('weekly:2026-W35:fish');
        expect(payoutKeyForPayload({ kind: 'items', listingId: 'l1' }))
            .toBe('listing:l1');
    });

    // The hourly competition the weekly one replaced is gone, but a payout it
    // owed can still be sitting in the queue. Dropping its derivation would not
    // fail loudly — it would replay unguarded and pay a second time.
    test('still derives the retired hourly key for a payout it left owed', () => {
        expect(payoutKeyForPayload({ kind: 'coins', hour: '2026-08-27T01', category: 'fish' }))
            .toBe('hourly:2026-08-27T01:fish');
    });

    test('an explicit key wins over anything derivable', () => {
        expect(payoutKeyForPayload({ kind: 'coins', hour: 'h', category: 'c', payoutKey: 'x' }))
            .toBe('x');
    });

    // A payload with nothing to key on replays exactly as it did before, and
    // says out loud that it is at-least-once rather than pretending otherwise.
    test('a payload with no key at all falls back to the unguarded credit', async () => {
        expect(payoutKeyForPayload({ kind: 'coins', userId: 'u1' })).toBeNull();

        await replayOwedPayout({ kind: 'coins', userId: 'u1', guildId: 'g1', amount: 500 });

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' },
            { $inc: { balance: 500 } },
        );
        expect(warnLog).toHaveBeenCalledWith(expect.stringContaining('at-least-once'));
    });
});

// #873. A duel refund moves coins *and* reverses `lifetimeGambled`, in one
// write. When that write fails the coins are recorded as owed — and if the
// record does not carry the counter too, the replay pays the stake back a week
// later and leaves the player counted as having gambled coins they were given
// back. The two have to travel together or the replay reproduces half a write.
describe('replayOwedPayout with bookkeeping counters', () => {
    const refund = {
        kind: 'coins', userId: 'u1', guildId: 'g1', amount: 250,
        payoutKey: 'duel:d1:refund:u1', counters: { lifetimeGambled: -250 },
    };

    test('moves the counters in the same guarded write as the coins', async () => {
        User.findOne.mockReturnValue({ lean: async () => null });

        await replayOwedPayout(refund);

        const [, update] = User.findOneAndUpdate.mock.calls[0];
        expect(update[0].$set.lifetimeGambled)
            .toEqual({ $add: [{ $ifNull: ['$lifetimeGambled', 0] }, -250] });
        expect(update[0].$set.balance)
            .toEqual({ $add: [{ $ifNull: ['$balance', 0] }, 250] });
    });

    test('carries them on the unguarded path too', async () => {
        const { payoutKey: _dropped, ...unkeyed } = refund;

        await replayOwedPayout(unkeyed);

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' },
            { $inc: { balance: 250, lifetimeGambled: -250 } },
        );
    });

    test('a payout with no counters writes only the coins', async () => {
        User.findOne.mockReturnValue({ lean: async () => null });

        await replayOwedPayout({ ...refund, counters: undefined });

        const [, update] = User.findOneAndUpdate.mock.calls[0];
        expect(update[0].$set).not.toHaveProperty('lifetimeGambled');
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
