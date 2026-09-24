'use strict';

// The profile and collection cards /hunt, /fish and /explore profile draw.
// What they look like is judged by eye; what is testable is that every branch
// renders a PNG of the size the layout promises — a max-level bar, an empty
// shelf, art that is and is not baked, an avatar that will not load — since
// a throw here costs the player the picture (the command sends the embed
// without it, see grindProfileView.renderAttachment).

const {
    createGrindProfileCard, createGrindCollectionCard, createGrindInventoryCard,
    COLL_COLS, INV_TILE_COLS, _resetCache, __test__,
} = require('../src/utils/grindProfileCard');
const { initials, shade } = __test__;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const size = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const baseCard = (overrides = {}) => ({
    activity: 'hunt',
    name: 'munge',
    avatarUrl: null,
    rankTitle: 'Marksman',
    level: 24,
    prestige: 0,
    xp: { total: 12_558, into: 758, span: 1_200 },
    place: { name: 'Arctic Tundra', iconId: 'hunt:arctic_tundra' },
    stamina: { current: 7, max: 10 },
    stats: [
        { label: 'Hunts', value: '239' }, { label: 'Success', value: '75%' },
        { label: 'Earned', value: '40,224' }, { label: 'Legendary', value: '5' },
    ],
    shelfTitle: 'Best trophies',
    shelf: [
        { iconId: 'animal:jackrabbit', name: 'Jackrabbit', badge: 'M', badgeColor: '#9b59b6' },
        { iconId: 'no-such:icon', name: 'Mystery Beast', badge: 'G' },
    ],
    ...overrides,
});

beforeEach(() => _resetCache());

describe('createGrindProfileCard', () => {
    test('renders the 1000×430 overview', async () => {
        const png = await createGrindProfileCard(baseCard());
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(size(png)).toEqual({ width: 1000, height: 430 });
    });

    test.each(['hunt', 'fish', 'explore', 'unknown'])('renders in the %s palette', async activity => {
        const png = await createGrindProfileCard(baseCard({ activity }));
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    });

    test('renders max level, prestige, an empty shelf and no place', async () => {
        const png = await createGrindProfileCard(baseCard({
            level: 50, prestige: 9, prestigeLabel: '💎 Diamond Prestige',
            xp: { total: 999_999, into: 0, span: null },
            place: null, stamina: { current: 0, max: 0 }, stats: [], shelf: [],
            shelfEmpty: 'No trophies yet.',
            name: 'a name far too long to fit on the card in one line at this size at all',
        }));
        expect(size(png)).toEqual({ width: 1000, height: 430 });
    });

    test('an avatar that will not load leaves the placeholder, not a failure', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const png = await createGrindProfileCard(baseCard({ avatarUrl: '/definitely/not/here.png' }));
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        console.error.mockRestore();
    });
});

describe('createGrindCollectionCard', () => {
    const section = (n, owned) => Array.from({ length: n }, (_, i) => ({
        iconId: i % 2 ? 'animal:wolf' : 'no-such:icon', name: `Thing ${i}`, owned: owned(i),
        badge: owned(i) ? String(i) : null, color: '#3498db',
    }));

    test('grows one row per fourteen entries, per section', async () => {
        const one = await createGrindCollectionCard({
            activity: 'fish', title: 'Catalog', subtitle: 'x',
            sections: [{ label: 'Common', entries: section(COLL_COLS, i => i < 3) }],
        });
        const two = await createGrindCollectionCard({
            activity: 'fish', title: 'Catalog', subtitle: 'x',
            sections: [{ label: 'Common', entries: section(COLL_COLS + 1, i => i < 3) }],
        });
        expect(size(two).height).toBeGreaterThan(size(one).height);
        expect(size(one).width).toBe(size(two).width);
    });

    test('renders an empty collection and skips empty sections', async () => {
        const png = await createGrindCollectionCard({
            activity: 'explore', title: 'Relic Case', subtitle: '',
            sections: [{ label: 'Rare', entries: section(5, () => false) }, { label: 'Empty', entries: [] }],
        });
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    });

    test('a complete collection renders too', async () => {
        const png = await createGrindCollectionCard({
            activity: 'hunt', title: 'Cabinet', subtitle: 'all of them',
            sections: [{ label: 'Epic', color: '#9b59b6', entries: section(3, () => true) }],
        });
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    });
});

describe('createGrindInventoryCard', () => {
    const rod = (n, over = {}) => ({
        iconId: n % 2 ? 'fish:carbon_rod' : 'no-such:icon', name: `Rod ${n}`, number: n,
        current: 50, max: 100, status: 'good', equipped: n === 1, ...over,
    });
    const tiles = n => Array.from({ length: n }, (_, i) => ({
        iconId: i % 2 ? 'fish:lure_pack' : null, name: `Stock ${i}`, count: i * 997, color: '#ecf0f1',
    }));
    const card = (over = {}) => ({
        activity: 'fish', title: "munge's Tackle Box", subtitle: '3 rods',
        buffs: ['Chum Bait (2 casts left)', "🍀 Angler's Luck queued"],
        gear: { label: 'Rods', count: 3, entries: [rod(1), rod(2, { status: 'broken', current: 0 }), rod(3, { tag: 'Enhanced Line' })] },
        sections: [{ label: 'Bait', entries: tiles(3) }, { label: 'Materials', entries: [] }],
        ...over,
    });

    test('renders a 1000-wide PNG', async () => {
        const png = await createGrindInventoryCard(card());
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(size(png).width).toBe(1000);
    });

    test('a stock section grows one row per full tile row', async () => {
        const one = size(await createGrindInventoryCard(card({ sections: [{ label: 'Bait', entries: tiles(INV_TILE_COLS) }] })));
        const two = size(await createGrindInventoryCard(card({ sections: [{ label: 'Bait', entries: tiles(INV_TILE_COLS + 1) }] })));
        expect(two.height).toBeGreaterThan(one.height);
    });

    test('draws only five rods and still renders with more, none, and no buffs', async () => {
        const many = await createGrindInventoryCard(card({
            gear: { label: 'Rods', entries: Array.from({ length: 9 }, (_, i) => rod(i + 1)), more: 4 },
        }));
        expect(many.subarray(0, 4)).toEqual(PNG_MAGIC);
        const empty = await createGrindInventoryCard(card({ buffs: [], gear: { label: 'Rods', entries: [] }, sections: [] }));
        expect(empty.subarray(0, 4)).toEqual(PNG_MAGIC);
    });
});

describe('the stand-in medallion', () => {
    test('initials skip the little words', () => {
        expect(initials('Whisperwood Charm')).toBe('WC');
        expect(initials('The Tenth Owl')).toBe('TO');
        expect(initials('the')).toBe('T');
        expect(initials('')).toBe('?');
        expect(initials(null)).toBe('?');
    });

    test('shade lightens, darkens, and leaves a non-colour alone', () => {
        expect(shade('#808080', 0.5)).toBe('#c0c0c0');
        expect(shade('#808080', -0.5)).toBe('#404040');
        expect(shade('not-a-colour', 0.5)).toBe('not-a-colour');
    });
});
