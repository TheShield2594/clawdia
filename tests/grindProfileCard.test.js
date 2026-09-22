'use strict';

// The profile and collection cards /hunt, /fish and /explore profile draw.
// What they look like is judged by eye; what is testable is that every branch
// renders a PNG of the size the layout promises — a max-level bar, an empty
// shelf, art that is and is not baked, an avatar that will not load — since
// a throw here costs the player the picture (the command sends the embed
// without it, see grindProfileView.renderAttachment).

const {
    createGrindProfileCard, createGrindCollectionCard, COLL_COLS, _resetCache, __test__,
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
