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
    cardChips, cardOptions, altText, renderHuntResultCard, standing, CARD_FILE,
} = require('../src/commands/economy/hunt/resultCard');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const size = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const base = (over = {}) => ({
    activity: 'hunt',
    kicker: 'TheShield bagged',
    subject: { name: 'Golden Fox', iconId: 'animal:golden_fox' },
    tierNum: 5,
    subtitle: 'Pristine Trophy · ×1.50',
    place: { name: 'Legendary Peaks', iconId: 'hunt:legendary_peaks' },
    payout: 1240,
    xp: 85,
    ...over,
});

describe('createGrindResultCard', () => {
    test('draws the catch card\'s 1000×440 frame', async () => {
        const png = await createGrindResultCard(base());
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(size(png)).toEqual({ width: 1000, height: 440 });
    });

    test('grows for a second row of badges, and again for an apex banner', async () => {
        const one  = size(await createGrindResultCard(base({ badges: [{ text: 'Perfect shot', tone: 'good' }] }))).height;
        const many = size(await createGrindResultCard(base({
            badges: Array.from({ length: 8 }, (_, i) => ({ text: `A fairly long badge ${i}`, tone: 'info' })),
        }))).height;
        const apex = size(await createGrindResultCard(base({
            badges: Array.from({ length: 8 }, (_, i) => ({ text: `A fairly long badge ${i}`, tone: 'info' })),
            apex: { outcome: 'perfect', title: 'PERFECT — Dire Alpha brought down', payout: 1800 },
        }))).height;
        expect(one).toBe(440);
        expect(many).toBeGreaterThan(one);
        expect(apex).toBeGreaterThan(many);
    });

    test('every branch draws: gauge, third tile, the cap, no art, no place, every apex outcome', async () => {
        const variants = [
            base({ gauge: { best: 2980, record: 3900 }, extraStat: { label: 'CRITICAL', value: '×2.13' } }),
            base({ gauge: { best: 0, record: 0 } }),
            base({ gauge: { best: 50_000, record: 90_000 } }),
            base({ payout: 0, forfeited: 9000, gauge: { best: 10, record: 20 } }),
            base({ subject: { name: 'Beast With No Art', iconId: 'animal:nope' }, place: null, tierNum: 1, subtitle: null }),
            base({ tierNum: 99, badges: [{ text: '🎯', tone: 'good' }, { text: 'Custom', color: '#123456' }] }),
            ...['perfect', 'win', 'survived', 'escaped', 'unknown'].map(outcome =>
                base({ apex: { outcome, title: 'Dire Alpha', payout: outcome === 'escaped' ? 0 : 500 } })),
        ];
        for (const v of variants) {
            expect((await createGrindResultCard(v)).subarray(0, 4)).toEqual(PNG_MAGIC);
        }
    });

    test('a banner can say its outcome in words in place of a bonus, in every palette', async () => {
        for (const activity of ['hunt', 'fish', 'mine', 'explore']) {
            const png = await createGrindResultCard(base({
                activity, apex: { label: 'CAVE-IN', outcome: 'win', title: 'Blasted clear with 2 charges', detail: '⛏️ haul kept' },
            }));
            expect(size(png).height).toBeGreaterThan(440);
        }
    });

    test('a gauge in its own unit draws against its own scale, even when the payout was capped', async () => {
        const png = await createGrindResultCard(base({
            payout: 0, forfeited: 300, gauge: { value: 4.2, unit: 'lbs', max: 12, best: 3.1, record: 9 },
        }));
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    });

    test('an enormous name and payout still fit the frame', async () => {
        const png = await createGrindResultCard(base({ subject: { name: 'A'.repeat(200), iconId: null }, payout: 123_456_789_012 }));
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

describe('where a payout stands', () => {
    test('beating everyone\'s best is a server record, and a personal best too', () => {
        expect(standing(5000, { priorBest: 3000, othersBest: 4000 }))
            .toEqual({ best: 3000, record: 4000, personalBest: true, serverRecord: true });
    });

    test('the record counts the hunter\'s own best when it is the biggest', () => {
        expect(standing(4500, { priorBest: 5000, othersBest: 4000 }))
            .toMatchObject({ record: 5000, personalBest: false, serverRecord: false });
    });

    test('a first-ever kill is not billed as a personal best', () => {
        expect(standing(100, { priorBest: 0, othersBest: 50 }).personalBest).toBe(false);
    });

    test('an unknown record claims nothing', () => {
        expect(standing(1e9, { priorBest: 10, othersBest: null })).toMatchObject({ record: null, serverRecord: false });
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

    test('the options carry the kill: who, art, tier, grade, zone', () => {
        const opts = cardOptions({ result: kill(), zone: ZONES.legendary_peaks, username: 'TheShield' });
        expect(opts.kicker).toBe('TheShield bagged');
        expect(opts.subject).toEqual({ name: 'Golden Fox', iconId: 'animal:golden_fox' });
        expect(opts.tierNum).toBe(5);
        expect(opts.subtitle).toBe(`Pristine Trophy · ×${quality.multiplier.toFixed(2)}`);
        expect(opts.place).toEqual({ name: ZONES.legendary_peaks.name, iconId: 'hunt:legendary_peaks' });
    });

    test('the third tile is the crit, else the combined multiplier, else a level-up, else nothing', () => {
        const flat = { isCrit: false, critMultiplier: 1, streakMult: 1, trophyQuality: null, levelUp: null };
        expect(cardOptions({ result: kill(), zone: ZONES.beginner_forest }).extraStat).toEqual({ label: 'CRITICAL', value: '×2.00' });
        expect(cardOptions({ result: kill({ ...flat, streakMult: 1.5 }), zone: ZONES.beginner_forest }).extraStat)
            .toEqual({ label: 'MULTIPLIER', value: '×1.50' });
        expect(cardOptions({ result: kill({ ...flat, levelUp: { oldLevel: 3, newLevel: 4 } }), zone: ZONES.beginner_forest }).extraStat)
            .toEqual({ label: 'LEVEL UP', value: '3 → 4' });
        expect(cardOptions({ result: kill(flat), zone: ZONES.beginner_forest }).extraStat).toBeNull();
    });

    test('an ungraded kill is named for its tier', () => {
        expect(cardOptions({ result: kill({ trophyQuality: null, tier: 'event' }), zone: ZONES.beginner_forest }).subtitle).toBe('Mythical kill');
    });

    test('the badges lead with the record, the best and the crit, then the run', () => {
        const opts = cardOptions({
            result: kill({ finalPayout: 5000 }), zone: ZONES.beginner_forest,
            records: { priorBest: 3000, othersBest: 4000 }, chips: [{ text: 'Perfect shot', tone: 'good' }],
        });
        expect(opts.badges.map(b => b.text)).toEqual(['SERVER RECORD', 'PERSONAL BEST', 'CRITICAL', 'LEVEL 11 → 12', 'Perfect shot']);
        expect(opts.gauge).toEqual({ best: 3000, record: 4000 });
    });

    test('a capped kill hands over what the cap took, and claims no record', () => {
        const opts = cardOptions({
            result: kill({ cappedByHard: true, finalPayout: 0, forfeitedPayout: 900 }), zone: ZONES.beginner_forest,
            records: { priorBest: 10, othersBest: 20 },
        });
        expect(opts).toMatchObject({ payout: 0, forfeited: 900 });
        expect(opts.badges.map(b => b.text)).not.toContain('SERVER RECORD');
        expect(altText(opts)).toContain('the daily cap withheld 900');
    });

    test('the alt text says what the picture shows', () => {
        const opts = cardOptions({
            result: kill(), zone: ZONES.legendary_peaks, username: 'TheShield', chips: [{ text: 'Perfect approach' }],
            apex: { outcome: 'win', title: 'Dire Alpha defeated', payout: 700 },
        });
        const alt = altText(opts);
        expect(alt).toContain('TheShield bagged a legendary Golden Fox in Legendary Peaks (Pristine Trophy');
        expect(alt).toContain('1,240 coins and 85 XP');
        expect(alt).toContain('critical ×2.00');
        expect(alt).toContain('Perfect approach');
        expect(alt).toContain('Apex duel: Dire Alpha defeated, 700 bonus coins');
        expect(altText(cardOptions({ result: kill({ tier: 'epic' }), zone: ZONES.beginner_forest }))).toContain('bagged an epic');
    });

    test('renders the picture embed and its file for a kill, and nothing for a miss', async () => {
        const card = await renderHuntResultCard({ result: kill(), zone: ZONES.legendary_peaks, chips: [] });
        expect(card.file.name).toBe(CARD_FILE);
        expect(card.embed.data.image.url).toBe(`attachment://${CARD_FILE}`);
        expect(await renderHuntResultCard({ result: { success: false }, zone: ZONES.beginner_forest, chips: [] })).toBeNull();
    });
});
