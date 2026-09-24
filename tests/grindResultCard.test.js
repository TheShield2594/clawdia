'use strict';

// The /hunt start picture card. How it looks is judged by eye; what is
// testable is that every branch draws a PNG of the height its layout promises,
// that nothing a canvas cannot draw reaches it, and that the hunt side hands it
// the right facts and says them again in the alt text.

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const { createGrindResultCard, __test__ } = require('../src/utils/grindResultCard');
const { plain } = __test__;
const { ANIMALS, ZONES, TROPHY_QUALITIES } = require('../src/data/huntData');
const {
    cardChips, cardOptions, altText, renderHuntResultCard, CARD_FILE,
} = require('../src/commands/economy/hunt/resultCard');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const size = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const base = (over = {}) => ({
    activity: 'hunt',
    subject: { name: 'Golden Fox', iconId: 'animal:golden_fox' },
    tierNum: 5,
    place: { name: 'Legendary Peaks', iconId: 'hunt:legendary_peaks' },
    payout: 1240,
    xp: 85,
    ...over,
});

describe('createGrindResultCard', () => {
    test('draws a 1000px-wide PNG', async () => {
        const png = await createGrindResultCard(base());
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(size(png).width).toBe(1000);
    });

    test('grows for chips and again for an apex banner', async () => {
        const bare  = size(await createGrindResultCard(base())).height;
        const chips = size(await createGrindResultCard(base({ chips: [{ text: 'Perfect approach', tone: 'good' }] }))).height;
        const apex  = size(await createGrindResultCard(base({
            chips: [{ text: 'Perfect approach', tone: 'good' }],
            apex: { outcome: 'perfect', title: 'PERFECT — Dire Alpha brought down', payout: 1800 },
        }))).height;
        expect(chips).toBeGreaterThan(bare);
        expect(apex).toBeGreaterThan(chips);
    });

    test('wraps a long run of chips onto more rows rather than off the edge', async () => {
        const one  = size(await createGrindResultCard(base({ chips: [{ text: 'Quick hunt' }] }))).height;
        const many = size(await createGrindResultCard(base({
            chips: Array.from({ length: 12 }, (_, i) => ({ text: `A fairly long chip number ${i}` })),
        }))).height;
        expect(many).toBeGreaterThan(one);
    });

    test('every branch draws: crit, grade, level-up, multipliers, the cap, no art, every apex outcome', async () => {
        const variants = [
            base({ crit: true, grade: { label: 'Mythic', color: '#9b59b6' }, levelUp: { from: 11, to: 12 },
                multipliers: [{ label: 'streak', value: 1.5 }, { label: 'crit', value: 2 }, { label: 'flat', value: 1 }] }),
            base({ payout: 0, forfeited: 9000 }),
            base({ subject: { name: 'Beast With No Art', iconId: 'animal:nope' }, place: null, tierNum: 1 }),
            base({ tierNum: 99 }),
            ...['perfect', 'win', 'survived', 'escaped', 'unknown'].map(outcome =>
                base({ apex: { outcome, title: 'Dire Alpha', payout: outcome === 'escaped' ? 0 : 500 } })),
        ];
        for (const v of variants) {
            expect((await createGrindResultCard(v)).subarray(0, 4)).toEqual(PNG_MAGIC);
        }
    });

    test('an enormous name still fits', async () => {
        const png = await createGrindResultCard(base({ subject: { name: 'A'.repeat(200), iconId: null } }));
        expect(size(png).width).toBe(1000);
    });
});

describe('plain — what a canvas can draw', () => {
    test('drops emoji, joiners and variation selectors, and the gaps they leave', () => {
        expect(plain('🤫 Perfect approach')).toBe('Perfect approach');
        expect(plain('🛡️ Armored — 🐻‍❄️ bear')).toBe('Armored — bear');
        expect(plain(null)).toBe('');
    });
});

describe('the hunt side of the card', () => {
    const quality = TROPHY_QUALITIES.find(q => q.id === 'pristine');
    const kill = (over = {}) => ({
        success: true, animal: ANIMALS.golden_fox, tier: 'legendary',
        finalPayout: 1240, xpEarned: 85, isCrit: true, critMultiplier: 2,
        streakMult: 1.5, trophyQuality: quality, levelUp: { oldLevel: 11, newLevel: 12 },
        specialDrop: { name: 'Golden Pelt' }, cappedByHard: false,
        ...over,
    });

    test('the chips name how the run went, in words rather than emoji', () => {
        const chips = cardChips({
            result: kill(), stealth: { outcome: 'perfect' }, aim: { grade: 'early' },
            quick: false, flushed: true, isFeaturedZone: true, featuredPct: 15, rarePetDrop: { name: 'Ember Fox' },
        }).map(c => c.text);
        expect(chips).toEqual([
            'Perfect approach', 'Flushed out bigger prey', 'Rushed shot', 'Featured zone +15%',
            'Found: Golden Pelt', 'Companion: Ember Fox',
        ]);
    });

    test('armored prey with no aim phase says why, and a quick hunt says it was quick', () => {
        const armored = kill({ animal: ANIMALS.musk_ox });
        expect(cardChips({ result: armored, stealth: { outcome: 'decent' }, aim: null, quick: false }).map(c => c.text))
            .toContain('Armored: no crit to aim for');
        expect(cardChips({ result: kill({ weaponBroke: true }), stealth: { outcome: 'skipped' }, aim: null, quick: true }).map(c => c.text))
            .toEqual(['Quick hunt', 'Found: Golden Pelt', 'Weapon broke']);
    });

    test('the options carry the kill: art, tier, zone, grade and only the multipliers that bit', () => {
        const opts = cardOptions({ result: kill(), zone: ZONES.legendary_peaks, chips: [] });
        expect(opts.subject).toEqual({ name: 'Golden Fox', iconId: 'animal:golden_fox' });
        expect(opts.tierNum).toBe(5);
        expect(opts.place.iconId).toBe('hunt:legendary_peaks');
        expect(opts.grade).toEqual({ label: 'Pristine', color: '#3498db' });
        expect(opts.multipliers).toEqual([
            { label: 'streak', value: 1.5 }, { label: 'crit', value: 2 }, { label: 'trophy', value: quality.multiplier },
        ]);
        expect(opts.levelUp).toEqual({ from: 11, to: 12 });
        expect(opts.forfeited).toBeNull();
    });

    test('a capped kill hands over what the cap took', () => {
        const opts = cardOptions({ result: kill({ cappedByHard: true, finalPayout: 0, forfeitedPayout: 900 }), zone: ZONES.beginner_forest, chips: [] });
        expect(opts).toMatchObject({ payout: 0, forfeited: 900 });
        expect(altText(opts)).toContain('the daily cap withheld 900');
    });

    test('the alt text says what the picture shows', () => {
        const opts = cardOptions({
            result: kill(), zone: ZONES.legendary_peaks, chips: [{ text: 'Perfect approach' }],
            apex: { outcome: 'win', title: 'Dire Alpha defeated', payout: 700 },
        });
        const alt = altText(opts);
        expect(alt).toContain('critical Pristine Golden Fox');
        expect(alt).toContain('legendary kill in Legendary Peaks');
        expect(alt).toContain('1,240 coins and 85 XP');
        expect(alt).toContain('Level up to 12');
        expect(alt).toContain('Perfect approach');
        expect(alt).toContain('Apex duel: Dire Alpha defeated, 700 bonus coins');
    });

    test('renders the picture embed and its file for a kill, and nothing for a miss', async () => {
        const card = await renderHuntResultCard({ result: kill(), zone: ZONES.legendary_peaks, chips: [] });
        expect(card.file.name).toBe(CARD_FILE);
        expect(card.embed.data.image.url).toBe(`attachment://${CARD_FILE}`);
        expect(await renderHuntResultCard({ result: { success: false }, zone: ZONES.beginner_forest, chips: [] })).toBeNull();
    });
});
