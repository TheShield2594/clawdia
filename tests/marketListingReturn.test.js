'use strict';

/**
 * #784. `returnExpiredMarketListings` is what stops items vanishing from the
 * economy when a market listing expires: TTL-deleted documents fire no Mongoose
 * hooks, so this job has to beat the TTL index to them.
 *
 * Its ordering is deliberate and inverted from what reads naturally — delete
 * first, credit second. The listing document is the only record that the return
 * is owed, so whoever deletes it owns the credit. Crediting first and deleting
 * after means a failed delete leaves the listing to be found and credited again
 * on the next tick, minting items. Nothing executed the job.
 */

jest.mock('../src/models/Guild', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User',  () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../src/models/MarketListing', () => ({ find: jest.fn(), findOneAndDelete: jest.fn() }));
jest.mock('../src/utils/inventoryGrant', () => ({ grantInventoryItem: jest.fn() }));
// Only recordOwedPayout is stubbed. `owedSummary` lives in the same module
// (#931) and is what the sweep's own error message is built from, so
// replacing the whole module would test the mock's wording rather than the
// one an operator reads.
jest.mock('../src/utils/owedPayout', () => ({
    ...jest.requireActual('../src/utils/owedPayout'),
    recordOwedPayout: jest.fn(),
}));

const MarketListing = require('../src/models/MarketListing');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const { returnExpiredMarketListings } = require('../src/services/marketService');

function listing(over = {}) {
    return { _id: 'l1', guildId: 'g1', sellerId: 'u1', itemId: 'sword', quantity: 2, expiresAt: new Date(0), ...over };
}

/** Records the `sort` and `limit` the sweep asked for, alongside the docs it gets back. */
function stubFind(docs) {
    const seen = {};
    MarketListing.find.mockImplementation(filter => {
        seen.filter = filter;
        return {
            sort: order => {
                seen.sort = order;
                return { limit: n => { seen.limit = n; return { lean: async () => docs }; } };
            },
        };
    });
    return seen;
}

let errorLog;
let infoLog;
let warnLog;

beforeEach(() => {
    jest.clearAllMocks();
    MarketListing.findOneAndDelete.mockImplementation(async filter => ({ _id: filter._id }));
    grantInventoryItem.mockResolvedValue({});
    recordOwedPayout.mockResolvedValue(true);
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    infoLog  = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnLog  = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => { errorLog.mockRestore(); infoLog.mockRestore(); warnLog.mockRestore(); });

describe('returnExpiredMarketListings', () => {
    test('sweeps expired listings in bounded batches', async () => {
        const seen = stubFind([]);

        await returnExpiredMarketListings();

        expect(seen.filter.expiresAt.$lte).toBeInstanceOf(Date);
        expect(seen.filter.expiresAt.$lte.getTime()).toBeLessThanOrEqual(Date.now());
        // Unbounded, one backlog of expiries pulls the whole collection into
        // the process at once.
        expect(seen.limit).toBe(50);
    });

    test('takes the oldest expiries first, so a capped tick cannot starve one', async () => {
        // Without a sort MongoDB returns natural order, which is not insertion
        // order and not stable — so a capped tick took an arbitrary 50 and a
        // listing could be passed over indefinitely while newer ones went
        // ahead. Since #867 every listing has a deadline: the TTL grace deletes
        // it seven days after it expires whether the sweep chose it or not.
        // Oldest first is what makes "the backlog drains" true of each listing
        // rather than only of the queue.
        const seen = stubFind([]);

        await returnExpiredMarketListings();

        expect(seen.sort).toEqual({ expiresAt: 1 });
    });

    test('says so when the batch cap leaves listings behind', async () => {
        // Before #867 a capped tick was invisible and looked harmless: the rest
        // waited for the next one. Now the TTL grace is what those stragglers
        // are living on, so a backlog is something an operator has to be able
        // to see coming.
        stubFind(Array.from({ length: 50 }, (_, i) => listing({ _id: `l${i}` })));

        await returnExpiredMarketListings();

        const warned = warnLog.mock.calls.flat().join(' ');
        expect(warned).toMatch(/batch capped at 50/);
        // Hitting the cap does not prove anything is behind it — fifty expiries
        // and an empty queue look identical from here — so the wording says
        // "may" rather than asserting a backlog it has not observed.
        expect(warned).toMatch(/there may be more/);
    });

    test('says nothing about a backlog on a tick that cleared the queue', async () => {
        stubFind(Array.from({ length: 49 }, (_, i) => listing({ _id: `l${i}` })));

        await returnExpiredMarketListings();

        expect(warnLog.mock.calls.flat().join(' ')).not.toMatch(/batch capped/);
    });

    test('claims the listing by deleting it before it credits anything', async () => {
        stubFind([listing()]);
        const order = [];
        MarketListing.findOneAndDelete.mockImplementation(async filter => { order.push('claim'); return { _id: filter._id }; });
        grantInventoryItem.mockImplementation(async () => { order.push('credit'); return {}; });

        await returnExpiredMarketListings();

        expect(order).toEqual(['claim', 'credit']);
        expect(MarketListing.findOneAndDelete).toHaveBeenCalledWith({ _id: 'l1' });
    });

    test('returns the full quantity to the seller in their own guild', async () => {
        stubFind([listing({ quantity: 7, itemId: 'potion' })]);

        await returnExpiredMarketListings();

        // Guarded by the listing's payout key (#807), so a return whose write
        // committed without its response arriving is not applied twice.
        const [userId, guildId, itemId, quantity, options] = grantInventoryItem.mock.calls[0];
        expect([userId, guildId, itemId, quantity]).toEqual(['u1', 'g1', 'potion', 7]);
        expect(options.guard).toEqual({ 'paidPayouts.key': { $ne: 'listing:l1' } });
        expect(JSON.stringify(options.extraSet.paidPayouts)).toContain('listing:l1');
    });

    test('a listing another worker already claimed is not credited again', async () => {
        stubFind([listing()]);
        MarketListing.findOneAndDelete.mockResolvedValue(null);

        await returnExpiredMarketListings();

        // This is the whole point of deleting first: minting a second copy of
        // the items is unrecoverable, losing one return is not.
        expect(grantInventoryItem).not.toHaveBeenCalled();
    });

    // #804. The claim is spent — the listing is deleted — so the next tick will
    // never find this return again. A log is not a record; the owed queue is.
    test('a credit that fails after the claim is written down as owed', async () => {
        stubFind([listing()]);
        grantInventoryItem.mockRejectedValue(new Error('mongo down'));

        await expect(returnExpiredMarketListings()).rejects.toThrow(/1 of 1/);

        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'marketService',
            jobName: 'returnExpiredMarketListings',
            guildId: 'g1',
            payload: {
                kind: 'items', userId: 'u1', guildId: 'g1',
                itemId: 'sword', quantity: 2, listingId: 'l1',
                payoutKey: 'listing:l1',
            },
        }));

        const message = errorLog.mock.calls[0].join(' ');
        expect(message).toContain('2x sword');
        expect(message).toContain('u1');
        expect(message).toContain('recorded for replay');
    });

    // The queue write fails for the same reason the credit did, often enough.
    // It must not take the rest of the sweep with it, and the job must still
    // fail so the run itself is on /health.
    test('a failed owed-queue write does not stop the sweep or hide the failure', async () => {
        stubFind([listing({ _id: 'bad' }), listing({ _id: 'good', sellerId: 'u2' })]);
        grantInventoryItem.mockImplementation(async sellerId => {
            if (sellerId === 'u1') throw new Error('mongo down');
            return {};
        });
        recordOwedPayout.mockResolvedValue(false);

        await expect(returnExpiredMarketListings()).rejects.toThrow(
            '1 of 2 expired listing(s) could not be returned (1 were) — none could be ' +
            'recorded as owed; they must be paid by hand, see the log above',
        );

        expect(grantInventoryItem).toHaveBeenCalledTimes(2);
    });

    test('one listing that fails does not strand the rest of the batch', async () => {
        stubFind([listing({ _id: 'bad' }), listing({ _id: 'good', sellerId: 'u2' })]);
        grantInventoryItem.mockImplementation(async sellerId => {
            if (sellerId === 'u1') throw new Error('mongo down');
            return {};
        });

        // The throw comes last, after every listing has had its turn.
        await expect(returnExpiredMarketListings()).rejects.toThrow('1 of 2 expired listing(s) could not be returned (1 were)');

        expect(grantInventoryItem).toHaveBeenCalledTimes(2);
        expect(infoLog.mock.calls.flat().join(' ')).toContain('1 expired listing(s)');
    });

    test('a claim that throws is counted, but the batch continues', async () => {
        stubFind([listing({ _id: 'bad' }), listing({ _id: 'good' })]);
        MarketListing.findOneAndDelete.mockImplementation(async filter => {
            if (filter._id === 'bad') throw new Error('mongo down');
            return { _id: filter._id };
        });

        await expect(returnExpiredMarketListings()).rejects.toThrow(/1 of 2/);

        expect(grantInventoryItem).toHaveBeenCalledTimes(1);
        // Nothing was claimed for the failing listing, so the next tick finds
        // it again — there is nothing owed to write down.
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('an empty sweep says nothing', async () => {
        stubFind([]);

        await returnExpiredMarketListings();

        expect(MarketListing.findOneAndDelete).not.toHaveBeenCalled();
        expect(infoLog).not.toHaveBeenCalled();
    });
});
