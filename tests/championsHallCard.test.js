'use strict';

// The Hall of Champions picture card. How it looks is judged by eye; what is
// testable is that it draws at the height its layout promises, that the week
// labels land on the right dates (the ISO year boundary included), that an
// unwon track keeps its plaque, and that the alt text says every champion.

const { createChampionsHallCard, altText, roleOf, MAX_WEEKS, __test__ } = require('../src/utils/championsHallCard');
const { boardAttachment } = require('../src/utils/leaderboardCard');
const { _resetCardRenderQueue } = require('../src/utils/cardRenderQueue');
const { weekLabel, cardHeight } = __test__;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const size = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const champ = (role, name, total, unit, runs = 1) => ({ role, name, total, unit, runs });
const week = (key, champions) => ({ week: key, champions });
const opts = (over = {}) => ({
    kicker: 'Test Guild',
    weeks: [
        week('2026-W38', {
            hunt: champ('HUNTER', 'Alice', 4000, 'coins hunted', 9),
            mine: champ('MINER', 'Bob', 3000, 'coins mined', 5),
            fish: champ('ANGLER', '🎣 Carol', 12, 'rarity score', 3),
            explore: champ('EXPLORER', 'Dave', 900, 'coins recovered'),
        }),
        week('2026-W37', { fish: champ('ANGLER', 'Erin', 7, 'rarity score') }),
    ],
    ...over,
});

beforeEach(() => _resetCardRenderQueue());

describe('createChampionsHallCard', () => {
    test('draws a row of plaques per week', async () => {
        const png = await createChampionsHallCard(opts());
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(size(png)).toEqual({ width: 1000, height: cardHeight(2, false) });
    });

    test('grows for a footer, and stops at the most weeks it draws', async () => {
        const withFooter = size(await createChampionsHallCard(opts({ footer: 'Crowned every Monday' }))).height;
        expect(withFooter).toBe(cardHeight(2, true));
        const many = Array.from({ length: MAX_WEEKS + 3 }, (_, i) => week(`2026-W${String(30 - i).padStart(2, '0')}`, {}));
        expect(size(await createChampionsHallCard({ weeks: many })).height).toBe(cardHeight(MAX_WEEKS, false));
    });

    test('draws a malformed week key and a week nobody won', async () => {
        const png = await createChampionsHallCard({ weeks: [week('someday', {}), week('2026-W01', undefined)] });
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    });
});

describe('weekLabel', () => {
    test('names the ISO week and its Monday-to-Sunday dates', () => {
        expect(weekLabel('2026-W38')).toEqual({ title: 'Week 38', range: 'Sep 14 – Sep 20, 2026' });
        // 2027-01-01 is a Friday, so it belongs to 2026's last week.
        expect(weekLabel('2026-W53')).toEqual({ title: 'Week 53', range: 'Dec 28 – Jan 3, 2027' });
        expect(weekLabel('2027-W01')).toEqual({ title: 'Week 1', range: 'Jan 4 – Jan 10, 2027' });
        expect(weekLabel('someday')).toEqual({ title: 'someday', range: '' });
    });
});

describe('roleOf', () => {
    test('reads the champion\'s title without the emoji or "of the Week"', () => {
        expect(roleOf('🏹 Hunter of the Week', 'hunt')).toBe('HUNTER');
        expect(roleOf(null, 'mine')).toBe('MINER');
        expect(roleOf('', 'explore')).toBe('EXPLORER');
    });
});

describe('altText', () => {
    test('says every week and every champion, emoji stripped', () => {
        const text = altText(opts());
        expect(text).toContain('Hall of Champions for Test Guild.');
        expect(text).toContain('Week 38 (Sep 14 – Sep 20, 2026): hunter Alice, 4,000 coins hunted over 9 runs;');
        expect(text).toContain('angler Carol, 12 rarity score over 3 runs');
        expect(text).toContain('explorer Dave, 900 coins recovered.');
        expect(text).toContain('Week 37 (Sep 7 – Sep 13, 2026): angler Erin, 7 rarity score.');
    });
});

describe('sent through the board path', () => {
    test('boardAttachment draws it with its own file name and alt text', async () => {
        const file = await boardAttachment('g1', {
            ...opts(), draw: createChampionsHallCard, describe: altText, fileName: 'hall-of-champions.png',
        });
        expect(file.name).toBe('hall-of-champions.png');
        expect(file.description).toContain('Hall of Champions for Test Guild.');
    });
});
