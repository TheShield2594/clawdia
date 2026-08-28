'use strict';

/**
 * #807. Every path that credits a user and writes the credit down as owed on
 * failure was at-least-once: a write can commit server-side and lose its
 * response, so the replay applies it a second time and the economy mints coins.
 *
 * The guard is a payout key in the credit's own filter. What these pin is the
 * part that is easy to get wrong — not that the guard exists, but that a
 * credit which matched nothing is correctly *classified*. Before the key,
 * `null` meant one thing: no user document, the payout is owed. Now it means
 * that or "already paid", and the two want opposite handling. Treating a
 * duplicate as owed loops the replay forever; treating a missing document as a
 * duplicate is #804 — the silently dropped payout — returning under a new name.
 */

jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/utils/inventoryGrant', () => ({ grantInventoryItem: jest.fn() }));

const User = require('../src/models/User');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const {
    payoutKeyAppendExpr, classifyUnmatchedPayout,
    creditCoinsOnce, grantItemOnce, weeklyChampionPayoutKey, hourlyPayoutKey, listingPayoutKey,
    RETENTION_MS, KEY_CAP,
} = require('../src/utils/payoutKey');

/** `Model.findOne(...).lean()` resolving to `doc`. */
function stubRead(doc) {
    User.findOne.mockReturnValue({ lean: async () => doc });
}

beforeEach(() => {
    // Reset, not clear: several cases below queue one-shot answers, and
    // `clearAllMocks` leaves an unconsumed queue behind for the next test to
    // pick up — which reads as a mock that has stopped working rather than as a
    // leak from three tests ago.
    jest.resetAllMocks();
    User.findOneAndUpdate.mockResolvedValue({ balance: 500 });
    grantInventoryItem.mockResolvedValue({});
    stubRead(null);
});

describe('the guard', () => {
    test('goes in the filter, where the credit itself evaluates it', async () => {
        await creditCoinsOnce({ userId: 'u1', guildId: 'g1' }, 500, 'k1');

        const [filter] = User.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ userId: 'u1', guildId: 'g1', 'paidPayouts.key': { $ne: 'k1' } });
    });

    // A key collection with a unique index makes the insert the guard, but the
    // insert and the credit are then two writes and a crash between them loses
    // the payout — the failure #804 closed. The credit and the key have to
    // commit together, which means one pipeline update.
    test('and the key it checks is written by the same update', async () => {
        await creditCoinsOnce({ userId: 'u1', guildId: 'g1' }, 500, 'k1');

        const [, update] = User.findOneAndUpdate.mock.calls[0];
        expect(Array.isArray(update)).toBe(true);
        expect(Object.keys(update[0].$set).sort()).toEqual(['balance', 'paidPayouts']);
    });
});

describe('payoutKeyAppendExpr', () => {
    // `$setUnion` is the pipeline form of `$addToSet` and reads like the right
    // operator here, but it returns a *set* with no defined order — so the
    // `$slice` below would evict arbitrary keys rather than the oldest, and the
    // retention bound would guarantee nothing. The filter already proves the
    // key is absent, so a plain append is correct and keeps insertion order.
    test('appends rather than unions, so the eviction order is defined', () => {
        const expr = payoutKeyAppendExpr('k1');
        const serialised = JSON.stringify(expr);

        expect(serialised).not.toContain('$setUnion');
        expect(serialised).not.toContain('$addToSet');
        expect(expr.$slice[0].$concatArrays[1]).toEqual([{ key: 'k1', at: '$$NOW' }]);
    });

    test('evicts from the front, so the newest key survives the cap', () => {
        expect(payoutKeyAppendExpr('k1').$slice[1]).toBe(-KEY_CAP);
    });

    test('prunes by age against the server clock, not the caller\'s', () => {
        const filter = payoutKeyAppendExpr('k1').$slice[0].$concatArrays[0].$filter;

        expect(filter.input).toEqual({ $ifNull: ['$paidPayouts', []] });
        expect(filter.cond.$gt[1]).toEqual({ $subtract: ['$$NOW', RETENTION_MS] });
    });

    // Keeping a key too long is a payout not made twice; dropping one early is a
    // payout made twice. Only one of those is worth defaulting to.
    test('keeps an entry with no timestamp rather than pruning it', () => {
        const cond = payoutKeyAppendExpr('k1').$slice[0].$concatArrays[0].$filter.cond;

        expect(cond.$gt[0]).toEqual({ $ifNull: ['$$p.at', '$$NOW'] });
    });

    // The window is a correctness parameter: past it a replay double-pays.
    test('honours a key for long enough that an operator can act on it', () => {
        expect(RETENTION_MS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
    });
});

describe('classifying a credit that matched nothing', () => {
    test('no document at all is still owed', async () => {
        stubRead(null);
        expect(await classifyUnmatchedPayout(User, { userId: 'u1', guildId: 'g1' }, 'k1'))
            .toBe('missing');
    });

    test('the key already on the document means it has been paid', async () => {
        stubRead({ paidPayouts: [{ key: 'k0' }, { key: 'k1' }] });
        expect(await classifyUnmatchedPayout(User, { userId: 'u1', guildId: 'g1' }, 'k1'))
            .toBe('duplicate');
    });

    // Neither — the document is there and the key is not, so the update should
    // have matched. Something wrote concurrently. Reported separately so a
    // caller records it as owed, which is safe: the replay carries the same key.
    test('a document without the key is neither, and says so', async () => {
        stubRead({ paidPayouts: [{ key: 'k0' }] });
        expect(await classifyUnmatchedPayout(User, { userId: 'u1', guildId: 'g1' }, 'k1'))
            .toBe('unknown');
    });

    test('a document that has never been paid anything is not a duplicate', async () => {
        stubRead({});
        expect(await classifyUnmatchedPayout(User, { userId: 'u1', guildId: 'g1' }, 'k1'))
            .toBe('unknown');
    });
});

describe('creditCoinsOnce', () => {
    test('reports a credit that landed', async () => {
        await expect(creditCoinsOnce({ userId: 'u1', guildId: 'g1' }, 500, 'k1'))
            .resolves.toEqual({ status: 'paid', doc: { balance: 500 } });
    });

    test('moves no coins for a payout already applied', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        stubRead({ paidPayouts: [{ key: 'k1' }] });

        await expect(creditCoinsOnce({ userId: 'u1', guildId: 'g1' }, 500, 'k1'))
            .resolves.toEqual({ status: 'duplicate', doc: null });
    });

    test('distinguishes that from a user who has no document to credit', async () => {
        User.findOneAndUpdate.mockResolvedValue(null);
        stubRead(null);

        await expect(creditCoinsOnce({ userId: 'u1', guildId: 'g1' }, 500, 'k1'))
            .resolves.toEqual({ status: 'missing', doc: null });
    });

    // Creating one would resurrect a pruned account, and would turn 'missing'
    // into something that never happens — which is the signal the owed queue
    // is built on.
    test('never creates a user document', async () => {
        await creditCoinsOnce({ userId: 'u1', guildId: 'g1' }, 500, 'k1');

        const [, , options] = User.findOneAndUpdate.mock.calls[0];
        expect(options.upsert).toBeUndefined();
    });
});

describe('grantItemOnce', () => {
    test('puts the guard on the grant\'s filter and the key in its update', async () => {
        await grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'listing:l1');

        const [userId, guildId, itemId, quantity, options] = grantInventoryItem.mock.calls[0];
        expect([userId, guildId, itemId, quantity]).toEqual(['u1', 'g1', 'sword', 2]);
        expect(options.guard).toEqual({ 'paidPayouts.key': { $ne: 'listing:l1' } });
        expect(options.extraSet.paidPayouts).toEqual(payoutKeyAppendExpr('listing:l1'));
    });

    test('grants nothing for a return already applied', async () => {
        grantInventoryItem.mockResolvedValue(null);
        stubRead({ paidPayouts: [{ key: 'listing:l1' }] });

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'listing:l1', { upsert: true }))
            .resolves.toEqual({ status: 'duplicate', doc: null });
        expect(grantInventoryItem).toHaveBeenCalledTimes(1);
    });

    // A guarded upsert on a document that already carries the key matches
    // nothing and so tries to *insert*, which the unique { userId, guildId }
    // index rejects. Classifying first is what keeps that error out of the
    // common path — the upsert only runs when there is genuinely no document.
    test('upserts only once it knows there is no document', async () => {
        grantInventoryItem.mockResolvedValueOnce(null).mockResolvedValueOnce({ created: true });
        stubRead(null);

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'k1', { upsert: true }))
            .resolves.toEqual({ status: 'paid', doc: { created: true } });

        expect(grantInventoryItem.mock.calls[0][4].upsert).toBeFalsy();
        expect(grantInventoryItem.mock.calls[1][4].upsert).toBe(true);
        // The guard stays on the insert, so a document created in between still
        // cannot be credited twice.
        expect(grantInventoryItem.mock.calls[1][4].guard).toEqual({ 'paidPayouts.key': { $ne: 'k1' } });
    });

    // A duplicate-key error from the insert says only that a document now
    // exists. That is true both when this payout has already landed and when
    // another writer simply created the user in between — and in the second
    // case nothing has been granted, so the guarded update is retried rather
    // than the race being reported as a duplicate.
    test('a document created in the meantime is credited on a retry, not called a duplicate', async () => {
        const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        grantInventoryItem
            .mockResolvedValueOnce(null)          // guarded update: no document
            .mockRejectedValueOnce(duplicate)     // insert: somebody made one first
            .mockResolvedValueOnce({ retried: true });
        stubRead(null);

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'k1', { upsert: true }))
            .resolves.toEqual({ status: 'paid', doc: { retried: true } });
    });

    // Two sweeps returning two expired listings to a seller with no document is
    // exactly that race. Reporting the loser as a duplicate would drop its
    // return without even recording it as owed.
    test('the loser of that race is not silently dropped', async () => {
        const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        grantInventoryItem
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(duplicate)
            .mockResolvedValueOnce(null);
        // The document the winner created carries the winner's key, not this one.
        User.findOne.mockReturnValue({ lean: async () => ({ paidPayouts: [{ key: 'other' }] }) });

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'k1', { upsert: true }))
            .resolves.toEqual({ status: 'unknown', doc: null });
    });

    test('but a document that really does carry the key is still a duplicate', async () => {
        const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        grantInventoryItem
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(duplicate)
            .mockResolvedValueOnce(null);
        User.findOne
            .mockReturnValueOnce({ lean: async () => null })
            .mockReturnValueOnce({ lean: async () => ({ paidPayouts: [{ key: 'k1' }] }) });

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'k1', { upsert: true }))
            .resolves.toEqual({ status: 'duplicate', doc: null });
    });

    test('any other failure of the insert still fails', async () => {
        grantInventoryItem.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('mongo down'));
        stubRead(null);

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'k1', { upsert: true }))
            .rejects.toThrow('mongo down');
    });

    test('without upsert, a missing document is reported rather than created', async () => {
        grantInventoryItem.mockResolvedValue(null);
        stubRead(null);

        await expect(grantItemOnce({ userId: 'u1', guildId: 'g1' }, 'sword', 2, 'k1'))
            .resolves.toEqual({ status: 'missing', doc: null });
        expect(grantInventoryItem).toHaveBeenCalledTimes(1);
    });
});

// The job that pays and the replay that re-pays have to build the same string,
// or the guard never fires and the double payment is silent.
describe('key construction', () => {
    test('a weekly reward is keyed by the week and the competition', () => {
        expect(weeklyChampionPayoutKey('2026-W35', 'fish')).toBe('weekly:2026-W35:fish');
    });

    // The hourly competition is gone, but payouts it owed can still be in the
    // queue and have to replay under the key they were guarded with.
    test('the retired hourly key is still built the way it was written', () => {
        expect(hourlyPayoutKey('2026-08-27T01', 'fish')).toBe('hourly:2026-08-27T01:fish');
    });

    test('a market return is keyed by the listing, which is deleted and never reused', () => {
        expect(listingPayoutKey('507f1f77bcf86cd799439011')).toBe('listing:507f1f77bcf86cd799439011');
    });

    test('an ObjectId is stringified rather than serialised as an object', () => {
        const oid = { toString: () => 'abc123' };
        expect(listingPayoutKey(oid)).toBe('listing:abc123');
    });
});
