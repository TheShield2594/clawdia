'use strict';

// The /fish cast catch card: the picture a landed fish's result carries. The
// options are a pure function of the cast result, pinned here; the render is
// checked to produce a PNG of the card's size.

const { catchCardOptions, catchCardAlt } = require('../src/commands/economy/fish/catchCard');
const { createCatchCard, CARD_W, CARD_H } = require('../src/utils/catchCard');
const { FISH, FISH_WEIGHTS } = require('../src/data/fishData');

const location = { name: 'Deep Ocean' };

function landed(overrides = {}) {
    return {
        fish: FISH.bass, tier: 'uncommon', weightLbs: 4.2, sizeLabel: 'Average',
        finalPayout: 95, xpEarned: 18, isCrit: false, critMultiplier: 1, streakMult: 1,
        ...overrides,
    };
}

test('the card names the fish, its tier, weight and payout, with its art', () => {
    const o = catchCardOptions({ result: landed(), location, worldRecord: null, reelResult: null, username: 'bob' });
    expect(o.fish).toEqual({ name: FISH.bass.name, iconId: 'fishcatch:bass' });
    expect(o.tierLabel).toBe('Uncommon');
    expect(o.weight).toBe(4.2);
    expect(o.payout).toBe(95);
    expect(o.gauge.min).toBeLessThan(FISH_WEIGHTS.bass.min);
    expect(o.gauge.max).toBeGreaterThan(FISH_WEIGHTS.bass.max);
});

test('the event tier is drawn as Mythical', () => {
    const o = catchCardOptions({ result: landed({ fish: FISH.sea_dragon, tier: 'event', weightLbs: 0 }), location, username: 'bob' });
    expect(o.tierLabel).toBe('Mythical');
    expect(o.gauge).toBeNull();
});

test('records and firsts become badges; the gauge carries the old best and the record', () => {
    const o = catchCardOptions({
        result: landed({ isPersonalBest: true, previousBest: 3.1, isCrit: true, critMultiplier: 2.1 }),
        location, username: 'bob',
        worldRecord: { set: true, previous: { weight: 4.0 } },
        reelResult: null,
    });
    expect(o.badges.map(b => b.text)).toEqual(['SERVER RECORD', 'PERSONAL BEST', 'CRITICAL']);
    expect(o.gauge.previousBest).toBe(3.1);
    expect(o.gauge.record).toBe(4.0);
    expect(o.extraStat).toEqual({ label: 'CRITICAL', value: '×2.10' });

    const first = catchCardOptions({ result: landed({ firstCatch: true }), location, username: 'bob', worldRecord: { set: false, record: { weight: 9 } } });
    expect(first.badges.map(b => b.text)).toEqual(['NEW SPECIES']);
    expect(first.gauge.record).toBe(9);
});

test('nothing on the card is a currency symbol, and the alt text says what it shows', () => {
    const o = catchCardOptions({ result: landed(), location, username: 'bob' });
    expect(JSON.stringify(o)).not.toMatch(/🪙|💰/);
    expect(catchCardAlt(o)).toBe('bob landed an average 4.2 lb Largemouth Bass, Uncommon, at Deep Ocean, for 95 coins and 18 XP.');
});

test('the card renders to a PNG of its size', async () => {
    const o = catchCardOptions({ result: landed({ isPersonalBest: true, previousBest: 3 }), location, username: 'bob', worldRecord: { set: false, record: { weight: 9 } } });
    const png = await createCatchCard(o);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(CARD_W);
    expect(png.readUInt32BE(20)).toBe(CARD_H);
});
