'use strict';

// The Explorer's Map, drawn (utils/exploreMapCard.js): that it produces a JPEG
// of the right size for a fresh explorer, a veteran and the awkward edges, that
// the painted world ships where the Docker image will carry it, that every
// region in the data has a place on the map, and that it draws from the same
// visibility rules as the text map (exploreService.mapRegionStates).

const { loadImage } = require('canvas');
const fs = require('fs');
const { createExploreMapCard, mapAltText, buildWorld, CARD_W, CARD_H, LAYOUT, WORLD_ART, __test__: { plain, placeRegions } } = require('../src/utils/exploreMapCard');
const { mapRegionStates, renderMap } = require('../src/services/exploreService');
const { REGION_LIST } = require('../src/data/exploreData');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const region = id => REGION_LIST.find(r => r.id === id);
const progress = (id, fraction = 1) => {
    const r = region(id);
    const take = list => list.slice(0, Math.round(list.length * fraction)).map(x => x.id);
    return { regionId: id, landmarksFound: take(r.landmarks), loreFound: take(r.lore), secretsFound: take(r.secrets) };
};
const explorer = (regions, unlockedRegions, activeRegion = 'whispering_forest') => ({
    exploration: { regions, unlockedRegions, activeRegion, level: 12 },
});

async function expectCard(buffer) {
    expect(buffer.subarray(0, 3)).toEqual(JPEG_MAGIC);
    const img = await loadImage(buffer);
    expect([img.width, img.height]).toEqual([CARD_W, CARD_H]);
}

describe('mapRegionStates', () => {
    test('classifies charted, known and locked regions and hides out-of-season seasonals', () => {
        const user = explorer(
            [progress('whispering_forest'), progress('crumbling_ruins', 0.4)],
            ['whispering_forest', 'crumbling_ruins', 'crystal_caves'],
            'crumbling_ruins',
        );
        const states = mapRegionStates(user, {});
        const byId = Object.fromEntries(states.map(s => [s.region.id, s]));

        expect(byId.whispering_forest).toMatchObject({ status: 'charted', pct: 100, surveyed: true, active: false });
        expect(byId.crumbling_ruins).toMatchObject({ status: 'charted', surveyed: false, active: true });
        expect(byId.crystal_caves.status).toBe('known');
        expect(byId.sunken_docks.status).toBe('locked');
        expect(states.some(s => s.seasonal)).toBe(false);
    });

    test('an in-season seasonal region surfaces as known; a disabled region vanishes', () => {
        const user = explorer([progress('whispering_forest')], ['whispering_forest']);
        const states = mapRegionStates(user, {
            activeEvent: { type: 'winter_wonderland' },
            exploration: { disabledRegions: ['crystal_caves'] },
        });
        const ids = states.map(s => s.region.id);
        expect(states.find(s => s.region.id === 'frostveil_pass')?.status).toBe('known');
        expect(ids).not.toContain('crystal_caves');
    });

    test('the text map is built from the same states, one entry each', () => {
        const user = explorer([progress('whispering_forest', 0.5)], ['whispering_forest', 'crumbling_ruins']);
        expect(renderMap(user, {})).toHaveLength(mapRegionStates(user, {}).length);
    });
});

describe('the painted world', () => {
    test('ships under src/ (the Docker context drops assets/) at the card\'s 3:2 shape', async () => {
        expect(WORLD_ART.split(require('path').sep)).toContain('src');
        expect(fs.existsSync(WORLD_ART)).toBe(true);
        const img = await loadImage(WORLD_ART);
        expect(img.width / img.height).toBeCloseTo(CARD_W / CARD_H, 2);
    });
});

describe('createExploreMapCard', () => {
    test('the world is decoded once and shared', async () => {
        expect(await buildWorld()).toBe(await buildWorld());
    });

    test('every region in the data has its own place on the map', () => {
        for (const r of REGION_LIST) expect([r.id, Boolean(LAYOUT[r.id])]).toEqual([r.id, true]);
    });

    test('a region with no place gets a spare slot instead of being dropped', () => {
        const placed = placeRegions([{ region: { id: 'somewhere_new' } }]);
        expect(placed[0].place).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), r: expect.any(Number) }));
    });

    test('draws a fresh explorer, a veteran and every seasonal region at once', async () => {
        const fresh = explorer([progress('whispering_forest', 0.2)], ['whispering_forest']);
        await expectCard(await createExploreMapCard({ states: mapRegionStates(fresh, {}), username: 'munge', level: 1 }));

        const everything = REGION_LIST.map(r => progress(r.id, r.seasonalEventId ? 0.5 : 1));
        const veteran = explorer(everything, REGION_LIST.map(r => r.id), 'starfall_wastes');
        await expectCard(await createExploreMapCard({ states: mapRegionStates(veteran, {}), username: 'TheShield', level: 30 }));
    });

    test('the awkward edges still draw: no regions, no name, an emoji-laden name', async () => {
        await expectCard(await createExploreMapCard({ states: [] }));
        const user = explorer([progress('whispering_forest')], ['whispering_forest']);
        await expectCard(await createExploreMapCard({
            states: mapRegionStates(user, {}),
            username: '🐸 a very long username that goes on 🗺️ and on',
        }));
    });

    test('draws identically twice — the clouds and markers are seeded, not random', async () => {
        const user = explorer([progress('whispering_forest', 0.6)], ['whispering_forest', 'crumbling_ruins']);
        const states = mapRegionStates(user, {});
        const a = await createExploreMapCard({ states, username: 'munge', level: 4 });
        const b = await createExploreMapCard({ states, username: 'munge', level: 4 });
        expect(a.equals(b)).toBe(true);
    });
});

describe('mapAltText', () => {
    test('names charted regions, withholds locked ones and strips emoji', () => {
        const user = explorer([progress('whispering_forest')], ['whispering_forest']);
        const alt = mapAltText(mapRegionStates(user, {}), 'munge 🐸');
        expect(alt).toContain('munge:');
        expect(alt).toContain('Whispering Forest 100% charted');
        expect(alt).toContain('an uncharted region (Explorer Lv 5)');
        expect(alt).not.toContain('Crumbling Ruins');
        expect(plain('🐸 *hi*')).toBe('hi');
    });
});
