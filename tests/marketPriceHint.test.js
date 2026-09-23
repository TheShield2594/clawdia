'use strict';

/**
 * The /market list price hint's wording. The queries are exercised through
 * tests/economyMarketCommand.test.js; this pins what a seller is actually told,
 * and in which order the figures are preferred.
 */

jest.mock('../src/models/MarketSale', () => ({ aggregate: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/MarketListing', () => ({ find: jest.fn() }));

const { shortHint, priceCheck, median, priceSnapshot } = require('../src/services/marketPriceService');
const MarketSale = require('../src/models/MarketSale');
const MarketListing = require('../src/models/MarketListing');

const forged = { kind: 'forged', value: 5000 };
const event  = { kind: 'event', value: 0 };

describe('shortHint', () => {
    it('leads with the median once there are enough sales to have one', () => {
        // One planted sale at 50,000 among ordinary ones does not set the headline.
        expect(shortHint({ lastPrice: 50_000, medianPrice: 3100, sales: 5 }, forged, '💰')).toBe('sells for ~💰3,100');
    });

    it('prefers the last sale, then the cheapest listing, then the game price', () => {
        expect(shortHint({ lastPrice: 3200, lowestListed: 900 }, forged, '💰')).toBe('last sold 💰3,200');
        expect(shortHint({ lastPrice: null, lowestListed: 900 }, forged, '💰')).toBe('listed from 💰900');
        expect(shortHint(undefined, forged, '💰')).toBe('forge cost 💰5,000');
    });

    it('says nothing when nothing is known', () => {
        expect(shortHint(undefined, event, '💰')).toBe('');
    });
});

describe('priceCheck', () => {
    const sold = { lastPrice: 300, lastSoldAt: new Date(), medianPrice: 300, sales: 3, lowestListed: 280 };

    it('lists what it knows', () => {
        const text = priceCheck(sold, forged, '💰', 310);
        expect(text).toContain('Last sold for **💰300**/ea');
        expect(text).toContain('Median of the last 3 sales');
        expect(text).toContain('Cheapest other listing: **💰280**/ea');
        expect(text).toContain('Forge cost: 💰5,000');
    });

    it('only passes a verdict on a clear outlier', () => {
        expect(priceCheck(sold, forged, '💰', 310)).not.toMatch(/Well (above|below)/);
        expect(priceCheck(sold, forged, '💰', 600)).toContain('Well above');
        expect(priceCheck(sold, forged, '💰', 150)).toContain('Well below');
    });

    it('judges against the game price when the item has never sold', () => {
        expect(priceCheck(undefined, forged, '💰', 20_000)).toContain('Well above');
    });

    it('is null with nothing to compare against', () => {
        expect(priceCheck(undefined, event, '💰', 100)).toBeNull();
    });
});

describe('median', () => {
    it('handles odd and even counts', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([1, 2, 3, 4])).toBe(3); // 2.5 rounds to 3
        expect(median([])).toBeNull();
    });
});

describe('priceSnapshot on a MongoDB older than 5.2', () => {
    it('falls back from $firstN to $push + $slice instead of losing the history', async () => {
        const unknownOperator = Object.assign(new Error('unknown group operator \'$firstN\''), { code: 15952 });
        MarketSale.aggregate
            .mockRejectedValueOnce(unknownOperator)
            .mockResolvedValueOnce([{ _id: 'gem', lastPrice: 120, lastSoldAt: new Date(), prices: [120, 100, 110] }]);
        MarketListing.find.mockReturnValue({ lean: async () => [] });

        const snap = await priceSnapshot('g1', ['gem']);

        expect(snap.get('gem')).toMatchObject({ lastPrice: 120, medianPrice: 110, sales: 3 });
        const fallback = MarketSale.aggregate.mock.calls[1][0];
        expect(fallback.find(stage => stage.$group).$group.prices).toEqual({ $push: '$pricePerUnit' });
        expect(fallback.find(stage => stage.$project).$project.prices).toEqual({ $slice: ['$prices', 10] });
    });
});
