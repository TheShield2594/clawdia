const { ensurePricingFields, nextPrice, decayDemand, trendBucket } = require('../src/utils/dynamicPricing');

describe('dynamicPricing', () => {
    test('ensurePricingFields fills in missing fields once', () => {
        const items = [
            { itemId: 'a', price: 100 },
            { itemId: 'b', price: 500, basePrice: 500, currentPrice: 600, demandScore: 3 },
        ];
        expect(ensurePricingFields(items)).toBe(true);
        expect(items[0].basePrice).toBe(100);
        expect(items[0].currentPrice).toBe(100);
        expect(items[0].demandScore).toBe(0);
        expect(items[1].currentPrice).toBe(600);
        expect(ensurePricingFields(items)).toBe(false); // idempotent
    });

    test('nextPrice rises when demand is positive, falls when negative', () => {
        const item = { basePrice: 1000, currentPrice: 1000, demandScore: 50 };
        const up = nextPrice(item, 0.5, 'medium');
        expect(up).toBeGreaterThan(item.currentPrice);

        const item2 = { basePrice: 1000, currentPrice: 1000, demandScore: -50 };
        const down = nextPrice(item2, 0.5, 'medium');
        expect(down).toBeLessThan(item2.currentPrice);
    });

    test('nextPrice respects the price band', () => {
        const item = { basePrice: 1000, currentPrice: 1000, demandScore: 999 };
        const high = nextPrice(item, 0.5, 'high');
        // Should not exceed base * (1 + band)
        expect(high).toBeLessThanOrEqual(1500);
        expect(high).toBeGreaterThanOrEqual(1);
    });

    test('decayDemand moves demand toward zero', () => {
        expect(decayDemand({ demandScore: 100 }, 'medium')).toBeLessThan(100);
        expect(decayDemand({ demandScore: 100 }, 'medium')).toBeGreaterThan(0);
        expect(decayDemand({ demandScore: -100 }, 'medium')).toBeGreaterThan(-100);
    });

    test('trendBucket classifies movement', () => {
        expect(trendBucket({ basePrice: 100, currentPrice: 130 }).arrow).toBe('🔥');
        expect(trendBucket({ basePrice: 100, currentPrice: 108 }).arrow).toBe('📈');
        expect(trendBucket({ basePrice: 100, currentPrice: 100 }).arrow).toBe('·');
        expect(trendBucket({ basePrice: 100, currentPrice: 92 }).arrow).toBe('📉');
        expect(trendBucket({ basePrice: 100, currentPrice: 70 }).arrow).toBe('🧊');
    });
});
