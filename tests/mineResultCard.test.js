'use strict';

// The /mine dig picture card (mine/resultCard.js): the options it hands the
// shared result card (utils/grindResultCard), the cave-in banner, and that the
// render comes out as the image-only embed leading the message — and not at
// all for ore that never came up.

const { cardOptions, cardChips, caveInBanner, altText, renderMineResultCard, CARD_FILE } = require('../src/commands/economy/mine/resultCard');
const { DEPTHS, ORES } = require('../src/data/mineData');

const ore = Object.values(ORES).find(o => o.tier === 'epic');
const depth = DEPTHS.crystal_caves;
const struck = (over = {}) => ({
    success: true, ore, tier: 'epic', finalPayout: 2400, xpEarned: 60,
    isCrit: false, critMultiplier: 1, streakMult: 1, levelUp: null, cappedByHard: false, ...over,
});

test('it is the shared card in the mine palette, with the ore and the depth it came from', () => {
    const o = cardOptions({ result: struck(), depth, intensity: { name: 'Deep', multiplier: 2 }, username: 'Bob' });
    expect(o).toMatchObject({
        activity: 'mine',
        kicker: 'Bob struck',
        subject: { name: ore.name, iconId: `ore:${ore.id}` },
        tierNum: 4,
        subtitle: 'Epic ore · Deep dig ×2',
        place: { name: depth.name, iconId: `mine:${depth.id}` },
        payout: 2400,
        forfeited: null,
        xp: 60,
        extraStat: null,
        apex: null,
    });
    expect(cardOptions({ result: struck({ tier: 'event' }), depth }).subtitle).toBe('Primordial ore');
});

test('the gauge sets the payout against the miner\'s best and the server record', () => {
    const o = cardOptions({ result: struck(), depth, records: { priorBest: 1800, othersBest: 3100 } });
    expect(o.gauge).toEqual({ best: 1800, record: 3100 });
    expect(o.badges.map(b => b.text)).toEqual(['PERSONAL BEST']);

    const top = cardOptions({ result: struck({ finalPayout: 5000 }), depth, records: { priorBest: 1800, othersBest: 3100 } });
    expect(top.badges.map(b => b.text)).toEqual(['SERVER RECORD', 'PERSONAL BEST']);

    // A failed record read draws no marker rather than a zero one.
    expect(cardOptions({ result: struck(), depth, records: { priorBest: 0, othersBest: null } }).gauge).toEqual({ best: 0, record: 0 });
});

test('the third tile is the crit, else the streak, else a level-up', () => {
    expect(cardOptions({ result: struck({ isCrit: true, critMultiplier: 2.1 }), depth }).extraStat).toEqual({ label: 'CRITICAL', value: '×2.10' });
    expect(cardOptions({ result: struck({ streakMult: 1.25 }), depth }).extraStat).toEqual({ label: 'MULTIPLIER', value: '×1.25' });
    const lv = cardOptions({ result: struck({ levelUp: { oldLevel: 4, newLevel: 5 } }), depth });
    expect(lv.extraStat).toEqual({ label: 'LEVEL UP', value: '4 → 5' });
    expect(lv.badges.map(b => b.text)).not.toContain('LEVEL 4 → 5');
    const both = cardOptions({ result: struck({ isCrit: true, critMultiplier: 2, levelUp: { oldLevel: 4, newLevel: 5 } }), depth });
    expect(both.badges.map(b => b.text)).toEqual(['CRITICAL', 'LEVEL 4 → 5']);
});

test('a capped dig shows what the cap withheld, and claims no record', () => {
    const o = cardOptions({ result: struck({ cappedByHard: true, finalPayout: 0, forfeited: 900 }), depth, records: { priorBest: 10, othersBest: 20 } });
    expect(o).toMatchObject({ payout: 0, forfeited: 900 });
    expect(o.badges).toEqual([]);
    expect(altText(o)).toContain('the daily cap withheld 900');
});

test('the chips say how the dig went, in words', () => {
    const chips = cardChips({
        result: struck({ specialDrop: { name: 'Crystal Shard' }, pickaxeBroke: true }),
        pickedIntensity: { name: 'Steady' }, chosenIntensity: { name: 'Hard', promoted: true },
        isFeaturedDepth: true, featuredPct: 15, rarePetDrop: { name: 'Crystal Fox' },
    });
    expect(chips.map(c => c.text)).toEqual([
        'Seam lifted Steady to Hard', 'Featured depth +15%', 'Found: Crystal Shard', 'Companion: Crystal Fox', 'Pickaxe broke',
    ]);
    expect(cardChips({ result: struck(), chosenIntensity: { name: 'Steady' } })).toEqual([]);
});

test('a cave-in the miner got out of is the banner; one they fled is not', () => {
    expect(caveInBanner(struck())).toBeNull();
    expect(caveInBanner(struck({ caveIn: true, caveInEscaped: true, caveInChargesSpent: 3 })))
        .toMatchObject({ label: 'CAVE-IN', outcome: 'win', title: 'Blasted clear with 3 charges', detail: 'haul kept' });
    expect(caveInBanner(struck({ caveIn: true, caveInEscaped: true, caveInChargesSpent: 1 })).title).toBe('Blasted clear with 1 charge');
    expect(caveInBanner(struck({ caveIn: true, caveInEscaped: true, caveInDugOut: true, caveInStaminaSpent: 2, caveInEscrowLost: 300 })))
        .toMatchObject({ outcome: 'survived', title: 'Dug out by hand for 2 stamina', detail: 'bonus buried' });
    expect(caveInBanner(struck({ caveIn: true, caveInEscaped: true, caveInDugOut: true, caveInStaminaSpent: 2 })).detail).toBe('ore saved');
    expect(caveInBanner(struck({ caveIn: true, caveInAbandoned: true }))).toBeNull();
    expect(caveInBanner(struck({ caveIn: true }))).toBeNull();
});

test('the render is an image-only embed leading the message, with alt text', async () => {
    const card = await renderMineResultCard({
        result: struck({ caveIn: true, caveInEscaped: true, caveInChargesSpent: 2 }), depth,
        intensity: { name: 'Deep', multiplier: 2 }, username: 'Bob', chips: [{ text: 'Featured depth +15%', tone: 'gold' }],
    });
    expect(card.embed.data.image.url).toBe(`attachment://${CARD_FILE}`);
    expect(card.embed.data.title).toBeUndefined();
    expect(card.file.name).toBe(CARD_FILE);
    expect(card.file.description).toBe(
        `Bob struck an epic ${ore.name} in ${depth.name} (Epic ore · Deep dig ×2). 2,400 coins and 60 XP. `
        + 'Featured depth +15%. Cave-in: Blasted clear with 2 charges, haul kept.',
    );
    expect(altText(cardOptions({ result: struck({ tier: 'common' }), depth }))).toContain('struck a common');
});

test('a failed swing and a haul left in a collapse get no card', async () => {
    expect(await renderMineResultCard({ result: { success: false }, depth })).toBeNull();
    expect(await renderMineResultCard({ result: struck({ caveIn: true, caveInAbandoned: true }), depth })).toBeNull();
    expect(await renderMineResultCard({ result: struck({ ore: null }), depth })).toBeNull();
});
