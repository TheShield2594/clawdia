'use strict';

// The /explore go picture card (explore/resultCard.js): which results earn one,
// what each find is drawn as, the options it hands the shared result card
// (utils/grindResultCard), and the alt text that says it again.

const fs = require('fs');
const path = require('path');
const {
    cardOptions, cardChips, describeFind, isCardResult, altText, renderExploreResultCard, CARD_FILE,
} = require('../src/commands/economy/explore/resultCard');
const { REGIONS, TREASURE_TIERS } = require('../src/data/exploreData');

const region = REGIONS.whispering_forest;
const tier = id => TREASURE_TIERS.find(t => t.tier === id);
const relic = region.relics.find(r => r.rarity === 'rare');
const treasure = (over = {}) => ({
    type: 'treasure', treasureTier: tier('uncommon'), payout: 600, grossPayout: 600, xp: 25, ...over,
});

describe('which expeditions get a card', () => {
    test('finds do; traps, quiet walks and lost encounters are misses', () => {
        for (const type of ['treasure', 'secret', 'discovery', 'lore']) expect(isCardResult({ type })).toBe(true);
        expect(isCardResult({ type: 'encounter', outcome: 'win' })).toBe(true);
        expect(isCardResult({ type: 'encounter', outcome: 'safe' })).toBe(true);
        expect(isCardResult({ type: 'encounter', outcome: 'loss' })).toBe(false);
        expect(isCardResult({ type: 'trap' })).toBe(false);
        expect(isCardResult({ type: 'quiet' })).toBe(false);
        expect(isCardResult(null)).toBe(false);
    });
});

describe('what the find is drawn as', () => {
    const regionArt = `explore:${region.id}`;

    test('a relic is recovered, drawn in its own art and graded by its own rarity', () => {
        const find = describeFind(treasure({ treasureTier: tier('epic'), relic }), region);
        expect(find.verb).toBe('recovered');
        expect(find.subject).toEqual({ name: relic.itemId, iconId: expect.stringMatching(/^relic:/) });
        expect(find.tierNum).toBe(3);
        expect(find.subtitle).toBe('Rare relic · from an epic treasure');
        expect(describeFind(treasure({ treasureTier: tier('rare'), relic }), region).subtitle).toBe('Rare relic · from a rare treasure');
    });

    test('a plain treasure is named for its tier, over the region\'s art', () => {
        expect(describeFind(treasure({ treasureTier: tier('legendary') }), region))
            .toEqual({ verb: 'found', subject: { name: 'Legendary Treasure', iconId: regionArt }, tierNum: 5, subtitle: 'Treasure' });
        expect(describeFind(treasure({ fallbackTreasure: true }), region).subtitle).toBe('Treasure, where the map ran out');
    });

    test('secrets, anomalies, landmarks, lore and encounters each say what they are', () => {
        const secret = region.secrets[0], anomaly = region.anomalies[0], landmark = region.landmarks[0], enc = region.encounters[0];
        expect(describeFind({ type: 'secret', secret }, region)).toMatchObject({ verb: 'uncovered', subject: { name: secret.name }, tierNum: 5 });
        expect(describeFind({ type: 'discovery', anomaly }, region)).toMatchObject({ verb: 'investigated', subject: { name: anomaly.name }, subtitle: 'Anomaly' });
        expect(describeFind({ type: 'discovery', landmark }, region)).toMatchObject({ verb: 'discovered', subject: { name: landmark.name }, tierNum: 2 });
        expect(describeFind({ type: 'lore' }, region).subtitle).toBe('A piece of the region\'s story');
        expect(describeFind({ type: 'lore', loreCompleted: true }, region).subtitle).toBe('The last of the story');
        expect(describeFind({ type: 'encounter', encounter: enc, outcome: 'win' }, region))
            .toMatchObject({ verb: 'met', subject: { name: enc.name }, tierNum: 3, subtitle: 'Approached, and won' });
        expect(describeFind({ type: 'encounter', encounter: enc, outcome: 'safe', hesitated: true }, region).subtitle)
            .toBe('Hesitated, and kept your distance');
        expect(describeFind({ type: 'encounter', encounter: enc, outcome: 'safe' }, region).subtitle).toBe('Kept your distance');
    });
});

describe('the options', () => {
    test('the shared card in the explore palette, with the region as the place', () => {
        const o = cardOptions({ result: treasure(), region, username: 'Bob', records: { priorBest: 400, othersBest: 900 } });
        expect(o).toMatchObject({
            activity: 'explore',
            kicker: 'Bob found',
            subject: { name: 'Uncommon Treasure' },
            tierNum: 2,
            place: { name: region.name, iconId: `explore:${region.id}` },
            payout: 600,
            forfeited: null,
            xp: 25,
            extraStat: null,
            gauge: { best: 400, record: 900 },
            apex: null,
        });
        expect(o.badges.map(b => b.text)).toEqual(['PERSONAL BEST']);
    });

    test('an explorer level-up is the third tile', () => {
        const o = cardOptions({ result: treasure({ explorerLevelUp: { oldLevel: 6, newLevel: 7 } }), region });
        expect(o.extraStat).toEqual({ label: 'LEVEL UP', value: '6 → 7' });
    });

    test('a hard-capped find shows what the cap withheld, and claims no record', () => {
        const o = cardOptions({ result: treasure({ payout: 0, grossPayout: 750, hardCapped: true }), region, records: { priorBest: 10, othersBest: 20 } });
        expect(o).toMatchObject({ payout: 0, forfeited: 750 });
        expect(o.badges).toEqual([]);
        expect(altText(o)).toContain('the daily cap withheld 750');
    });

    test('charting the whole region is the banner', () => {
        const o = cardOptions({ result: treasure({ regionCompleted: true, surveyBonus: 0.1 }), region });
        expect(o.apex).toEqual({
            label: 'REGION SURVEYED', outcome: 'perfect',
            title: `${region.name} is fully charted`, detail: '+10% here from now on',
        });
    });
});

describe('the chips', () => {
    test('the bonuses that lifted a paying run, then what came with it', () => {
        const chips = cardChips({
            result: treasure({
                route: 'deep', streakBonus: 0.06, featured: true, firstVisit: true, relic, relicIsNew: true,
                material: { label: 'Moss Thread' }, injured: true,
            }),
            rarePetDrop: { name: 'Lantern Owl' }, featuredPct: 15,
        });
        expect(chips.map(c => c.text)).toEqual([
            'Deep Wilds +30%', 'Streak +6%', 'Featured region +15%', 'First visit', 'New to your case',
            'Found: Moss Thread', 'Companion: Lantern Owl', 'Injured',
        ]);
    });

    test('a route that costs says so; a run that paid nothing claims no bonus', () => {
        expect(cardChips({ result: treasure({ route: 'trail' }) }).map(c => c.text)).toEqual(['Main Trail −10%']);
        expect(cardChips({ result: treasure({ route: 'deep', streakBonus: 0.1, featured: true, payout: 0 }) })).toEqual([]);
        expect(cardChips({ result: treasure({ route: 'offpath' }) })).toEqual([]);
    });

    test('a relic that never reached the bag is not billed as new', () => {
        expect(cardChips({ result: treasure({ relic, relicIsNew: true, relicOwed: 'owed' }) })).toEqual([]);
    });
});

describe('the render', () => {
    test('an image-only embed leading the message, with alt text', async () => {
        const card = await renderExploreResultCard({
            result: treasure({ treasureTier: tier('epic'), relic, regionCompleted: true, surveyBonus: 0.1 }), region, username: 'Bob',
        });
        expect(card.embed.data.image.url).toBe(`attachment://${CARD_FILE}`);
        expect(card.embed.data.title).toBeUndefined();
        expect(card.file.name).toBe(CARD_FILE);
        expect(card.file.description).toBe(
            `Bob recovered ${relic.itemId} in ${region.name} (rare; Rare relic · from an epic treasure). 600 coins and 25 XP. `
            + `${region.name} is fully charted: +10% here from now on.`,
        );
    });

    test('every kind of find draws', async () => {
        const results = [
            { type: 'secret', secret: region.secrets[0], payout: 4000, xp: 50 },
            { type: 'discovery', anomaly: region.anomalies[0], payout: 500, xp: 30 },
            { type: 'discovery', landmark: region.landmarks[0], payout: 400, xp: 20 },
            { type: 'lore', payout: 200, xp: 15, explorerLevelUp: { oldLevel: 2, newLevel: 3 } },
            { type: 'encounter', encounter: region.encounters[0], outcome: 'win', payout: 1200, xp: 40 },
        ];
        for (const result of results) {
            const card = await renderExploreResultCard({ result, region, records: { priorBest: 300, othersBest: 5000 } });
            expect(card.file.name).toBe(CARD_FILE);
        }
    });

    test('a miss gets no card', async () => {
        expect(await renderExploreResultCard({ result: { type: 'trap', trap: region.traps[0], payout: 0 }, region })).toBeNull();
        expect(await renderExploreResultCard({ result: { type: 'encounter', outcome: 'loss', payout: 0 }, region })).toBeNull();
    });
});

describe('/explore go leads a find with the card', () => {
    // Driving go.js through a mocked Discord client costs more than it proves;
    // pin the wiring by source, as exploreGoResult.test.js does.
    const src = fs.readFileSync(path.join(__dirname, '../src/commands/economy/explore/go.js'), 'utf8');

    test('reads the best haul before the expedition books its own', () => {
        expect(src.indexOf('const priorBest = e.bestHaul')).toBeLessThan(src.indexOf('executeExplore(user, region'));
        expect(src).toContain("serverBest(interaction.guild.id, 'exploration', 'bestHaul', interaction.user.id)");
    });

    test('the card leads the result, and the thumbnail is only the fallback', () => {
        expect(src).toContain('embeds: card ? [card.embed, embed] : [embed]');
        expect(src).toMatch(/if \(card\) \{\s*files = \[card\.file\];\s*\} else \{[\s\S]*attachItemThumbnail/);
    });
});
