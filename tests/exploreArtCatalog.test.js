'use strict';

// Explore gets baked icon art in two families, keyed in src/data/activityItems.js:
// regions under an `explore:` namespace (the analog of hunt zones / fish
// locations / mine depths) and relics under a `relic:` namespace (the analog of
// the catch/kill/mine results). Three things have to stay true or a region or
// relic ships with no art slot: the id sets must track the live game data
// (REGION_LIST and RELIC_LIST in exploreData), the relic slugs must be unique
// and filename-safe, and the icon manifest that drives generation must carry a
// prompt for every key.
//
// Explore art is *bundle-only* by decision (the same call #1080 made for pets):
// /explore has no dashboard economy panel to upload against, so these keys must
// NOT be accepted by the upload route. That is asserted here too, so a later
// change that folds them into isUploadableItemId is a deliberate one.

const {
    EXPLORE_ITEMS, EXPLORE_ITEM_IDS, exploreRegionItemId, relicItemId, isExploreItemId,
    isUploadableItemId, ACTIVITY_ITEM_IDS, RESULT_ITEM_IDS, PET_ITEM_IDS,
} = require('../src/data/activityItems');
const { REGION_LIST, RELIC_LIST, relicSlug } = require('../src/data/exploreData');
const manifest = require('../assets/icons/manifest.json');

// The shape the image routes require of any id (see itemImages.js / STYLE.md §4b).
const ROUTE_ID_SHAPE = /^[a-z0-9_:-]{1,64}$/;

describe('the explore art roster tracks the game data', () => {
    test('every region is an explore-art id, and none stray', () => {
        const regionIds = REGION_LIST.map(r => exploreRegionItemId(r.id));
        expect(EXPLORE_ITEMS.regions.map(i => i.id).sort()).toEqual([...regionIds].sort());
        for (const r of REGION_LIST) {
            expect(exploreRegionItemId(r.id)).toBe(`explore:${r.id}`);
            expect(isExploreItemId(`explore:${r.id}`)).toBe(true);
        }
    });

    test('every relic is an explore-art id, and none stray', () => {
        const relicIds = RELIC_LIST.map(r => relicItemId(r.slug));
        expect(EXPLORE_ITEMS.relics.map(i => i.id).sort()).toEqual([...relicIds].sort());
        for (const r of RELIC_LIST) {
            expect(relicItemId(r.slug)).toBe(`relic:${r.slug}`);
            expect(isExploreItemId(`relic:${r.slug}`)).toBe(true);
        }
    });

    test('the set and the guard agree, with no bare or unknown key slipping through', () => {
        const all = Object.values(EXPLORE_ITEMS).flat();
        expect(EXPLORE_ITEM_IDS.size).toBe(all.length);
        expect(isExploreItemId('explore:whispering_forest')).toBe(true);
        expect(isExploreItemId('relic:whisperwood_charm')).toBe(true);
        expect(isExploreItemId('whispering_forest')).toBe(false);
        expect(isExploreItemId('explore:not_a_region')).toBe(false);
        expect(isExploreItemId('relic:not_a_relic')).toBe(false);
    });

    test('relic slugs are unique and filename-safe', () => {
        const slugs = RELIC_LIST.map(r => r.slug);
        // Derived from the display name, so a name that slugged to an existing
        // one would silently overwrite its art — assert the mapping is 1:1.
        expect(new Set(slugs).size).toBe(slugs.length);
        for (const r of RELIC_LIST) {
            expect(r.slug).toBe(relicSlug(r.itemId));
            expect(r.slug).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);
        }
    });

    test('every explore key passes the image route\'s shape check', () => {
        const malformed = [...EXPLORE_ITEM_IDS].filter(id => !ROUTE_ID_SHAPE.test(id));
        expect(malformed).toEqual([]);
    });
});

describe('explore art is bundle-only, not uploadable', () => {
    test('no explore key is accepted by the upload route', () => {
        for (const id of EXPLORE_ITEM_IDS) {
            expect(isUploadableItemId(id)).toBe(false);
        }
    });

    test('explore keys never collide with a gear, result or pet id', () => {
        for (const id of EXPLORE_ITEM_IDS) {
            expect(ACTIVITY_ITEM_IDS.has(id)).toBe(false);
            expect(RESULT_ITEM_IDS.has(id)).toBe(false);
            expect(PET_ITEM_IDS.has(id)).toBe(false);
        }
    });
});

describe('the icon manifest covers every explore key', () => {
    const exploreEntries = manifest.filter(m => m.key.startsWith('explore:') || m.key.startsWith('relic:'));

    test('exactly one manifest entry per region and relic, and none stray', () => {
        expect(exploreEntries.map(m => m.key).sort()).toEqual([...EXPLORE_ITEM_IDS].sort());
    });

    test('every explore entry carries a prompt, rarity and rim, and a matching filename', () => {
        for (const m of exploreEntries) {
            expect(m.prompt).toMatch(/^Game item icon: /);
            expect(m.prompt).toContain('rarity rim,');
            expect(typeof m.rarity).toBe('string');
            expect(m.rim.length).toBeGreaterThan(0);
            expect(m.file).toBe(`${m.key.replace(/:/g, '__')}.png`);
        }
    });

    test('relics only ever carry the three tiers they can drop at', () => {
        const relicRarities = new Set(exploreEntries.filter(m => m.key.startsWith('relic:')).map(m => m.rarity));
        expect([...relicRarities].sort()).toEqual(['Epic', 'Legendary', 'Rare']);
    });
});
