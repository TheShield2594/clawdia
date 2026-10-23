'use strict';

// The /fish cast picture card (fish/resultCard.js): the options it hands the
// shared result card (utils/grindResultCard — the card /hunt start draws), and
// that the render comes out as the image-only embed leading the message.

const { cardOptions, cardChips, altText, renderFishResultCard, CARD_FILE } = require('../src/commands/economy/fish/resultCard');
const { FISH, FISH_WEIGHTS, LOCATIONS } = require('../src/data/fishData');

const landed = (overrides = {}) => ({
    success: true, catchType: 'fish', fish: FISH.bass, tier: 'uncommon', weightLbs: 4.2, sizeLabel: 'Average',
    finalPayout: 95, xpEarned: 18, isCrit: false, critMultiplier: 1, streakMult: 1, ...overrides,
});

test('it is the shared card in the fish palette, with the fish and the water it came from', () => {
    const o = cardOptions({ result: landed(), location: LOCATIONS.pond, username: 'Bob' });
    expect(o).toMatchObject({
        activity: 'fish',
        kicker: 'Bob landed',
        subject: { name: FISH.bass.name, iconId: 'fishcatch:bass' },
        tierNum: 2,
        subtitle: 'Average · 4.2 lbs',
        place: { name: LOCATIONS.pond.name, iconId: 'fish:pond' },
        payout: 95,
        forfeited: null,
        xp: 18,
    });
});

test('a fish is measured by weight: the gauge spans its species, with the old best and the record', () => {
    const o = cardOptions({
        result: landed({ previousBest: 3.1 }), location: LOCATIONS.pond, username: 'Bob',
        worldRecord: { set: false, record: { weight: 9 } },
    });
    expect(o.gauge).toMatchObject({ value: 4.2, unit: 'lbs', best: 3.1, record: 9 });
    expect(o.gauge.max).toBeGreaterThan(FISH_WEIGHTS.bass.max);

    const setIt = cardOptions({ result: landed(), location: LOCATIONS.pond, worldRecord: { set: true, previous: { weight: 4.0 } } });
    expect(setIt.gauge.record).toBe(4.0);
    expect(setIt.badges[0]).toEqual({ text: 'SERVER RECORD', tone: 'gold' });
});

test('an unweighed fish names its tier instead, and draws no gauge', () => {
    const o = cardOptions({ result: landed({ fish: FISH.sea_dragon, tier: 'event', weightLbs: 0, sizeLabel: null }), location: LOCATIONS.ocean });
    expect(o.subtitle).toBe('Mythical catch');
    expect(o.tierNum).toBe(6);
    expect(o.gauge).toBeNull();
});

test('a capped catch shows what the cap withheld, not a payout', () => {
    const o = cardOptions({ result: landed({ cappedByHard: true, finalPayout: 0, uncappedPayout: 240 }), location: LOCATIONS.pond });
    expect(o.payout).toBe(0);
    expect(o.forfeited).toBe(240);
    expect(altText(o)).toContain('the daily cap withheld 240');
});

test('badges lead with the records, then the run’s chips', () => {
    const chips = cardChips({
        result: landed({ karmaUsed: true, rodBroke: true }), reelResult: { icon: '🎯' },
        isFeaturedSpot: true, featuredPct: 20, rarePetDrop: null, winterMaterialName: null,
    });
    expect(chips.map(c => c.text)).toEqual(['Perfect read', 'River karma', 'Featured spot +20%', 'Rod broke']);
    const o = cardOptions({ result: landed({ isPersonalBest: true, firstCatch: false, isCrit: true, critMultiplier: 2 }), location: LOCATIONS.pond, chips });
    expect(o.badges.map(b => b.text)).toEqual(['PERSONAL BEST', 'CRITICAL', 'Perfect read', 'River karma', 'Featured spot +20%', 'Rod broke']);
    expect(o.extraStat).toEqual({ label: 'CRITICAL', value: '×2.00' });
});

test('the render is an image-only embed leading the message, with alt text', async () => {
    const card = await renderFishResultCard({ result: landed({ firstCatch: true }), location: LOCATIONS.pond, username: 'Bob' });
    expect(card.embed.data.image.url).toBe(`attachment://${CARD_FILE}`);
    expect(card.embed.data.title).toBeUndefined();
    expect(card.file.name).toBe(CARD_FILE);
    expect(card.file.description).toBe('Bob landed an uncommon Largemouth Bass at Quiet Pond (Average · 4.2 lbs). 95 coins and 18 XP. NEW SPECIES.');
});

test('junk, treasure and misses get no card', async () => {
    expect(await renderFishResultCard({ result: { success: true, catchType: 'junk' }, location: LOCATIONS.pond })).toBeNull();
    expect(await renderFishResultCard({ result: { success: false }, location: LOCATIONS.pond })).toBeNull();
});
