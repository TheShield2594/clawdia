'use strict';

/**
 * The /market list price hint's wording. The queries are exercised through
 * tests/economyMarketCommand.test.js; this pins what a seller is actually told,
 * and in which order the figures are preferred.
 */

jest.mock('../src/models/MarketSale', () => ({ aggregate: jest.fn(), create: jest.fn() }));
jest.mock('../src/models/MarketListing', () => ({ find: jest.fn() }));

const { shortHint, priceCheck, median } = require('../src/services/marketPriceService');

const forged = { kind: 'forged', value: 5000 };
const event  = { kind: 'event', value: 0 };

describe('shortHint', () => {
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
