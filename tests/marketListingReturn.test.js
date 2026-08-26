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

const MarketListing = require('../src/models/MarketListing');
const { grantInventoryItem } = require('../src/utils/inventoryGrant');
const { returnExpiredMarketListings } = require('../src/services/schedulerService');

function listing(over = {}) {
    return { _id: 'l1', guildId: 'g1', sellerId: 'u1', itemId: 'sword', quantity: 2, expiresAt: new Date(0), ...over };
}

/** Records the `limit` the sweep asked for alongside the docs it gets back. */
function stubFind(docs) {
    const seen = {};
    MarketListing.find.mockImplementation(filter => {
        seen.filter = filter;
        return { limit: n => { seen.limit = n; return { lean: async () => docs }; } };
    });
    return seen;
}

let errorLog;
let infoLog;

beforeEach(() => {
    jest.clearAllMocks();
    MarketListing.findOneAndDelete.mockImplementation(async filter => ({ _id: filter._id }));
    grantInventoryItem.mockResolvedValue({});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    infoLog  = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => { errorLog.mockRestore(); infoLog.mockRestore(); });

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

        expect(grantInventoryItem).toHaveBeenCalledWith('u1', 'g1', 'potion', 7, { upsert: true });
    });

    test('a listing another worker already claimed is not credited again', async () => {
        stubFind([listing()]);
        MarketListing.findOneAndDelete.mockResolvedValue(null);

        await returnExpiredMarketListings();

        // This is the whole point of deleting first: minting a second copy of
        // the items is unrecoverable, losing one return is not.
        expect(grantInventoryItem).not.toHaveBeenCalled();
    });

    test('a credit that fails after the claim is logged loudly, not retried', async () => {
        stubFind([listing()]);
        grantInventoryItem.mockRejectedValue(new Error('mongo down'));

        await expect(returnExpiredMarketListings()).resolves.toBeUndefined();

        // The listing is gone, so nothing will find this again — the log is the
        // only record that the items are owed, and it has to say so.
        const message = errorLog.mock.calls[0].join(' ');
        expect(message).toContain('2x sword');
        expect(message).toContain('u1');
        expect(message).toContain('by hand');
    });

    test('one listing that fails does not strand the rest of the batch', async () => {
        stubFind([listing({ _id: 'bad' }), listing({ _id: 'good', sellerId: 'u2' })]);
        grantInventoryItem.mockImplementation(async sellerId => {
            if (sellerId === 'u1') throw new Error('mongo down');
            return {};
        });

        await returnExpiredMarketListings();

        expect(grantInventoryItem).toHaveBeenCalledTimes(2);
        expect(infoLog.mock.calls.flat().join(' ')).toContain('1 expired listing(s)');
    });

    test('a claim that throws is caught, so the batch continues', async () => {
        stubFind([listing({ _id: 'bad' }), listing({ _id: 'good' })]);
        MarketListing.findOneAndDelete.mockImplementation(async filter => {
            if (filter._id === 'bad') throw new Error('mongo down');
            return { _id: filter._id };
        });

        await expect(returnExpiredMarketListings()).resolves.toBeUndefined();

        expect(grantInventoryItem).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalled();
    });

    test('an empty sweep says nothing', async () => {
        stubFind([]);

        await returnExpiredMarketListings();

        expect(MarketListing.findOneAndDelete).not.toHaveBeenCalled();
        expect(infoLog).not.toHaveBeenCalled();
    });
});
