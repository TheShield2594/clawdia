'use strict';

// Pets get baked portrait art (issue #1082), keyed under a `pet:` namespace in
// src/data/activityItems.js. Two things have to stay true or a species ships
// with no art slot: the id list must track the live roster (the ownable pets in
// petService's PET_DEFINITIONS plus the wild battle opponents), and the icon
// manifest that drives generation must carry a prompt for each one.
//
// Pet art is *bundle-only* by decision (#1080 made the baked catalogue
// authoritative): there is no dashboard panel to upload a pet portrait, so pet
// keys must NOT be accepted by the upload route. That is asserted here too, so a
// later change that folds pets into isUploadableItemId is a deliberate one.

const {
    PET_SPECIES_IDS, PET_ITEM_IDS, petItemId, isPetItemId,
    isUploadableItemId, ACTIVITY_ITEM_IDS, RESULT_ITEM_IDS,
} = require('../src/data/activityItems');
const { PET_DEFINITIONS, WILD_PET_IDS } = require('../src/services/petService');
const manifest = require('../assets/icons/manifest.json');

// The shape the image routes require of any id (see itemImages.js / STYLE.md §4b).
const ROUTE_ID_SHAPE = /^[a-z0-9_:-]{1,64}$/;

describe('the pet art roster tracks the live pet roster', () => {
    test('every ownable pet and wild opponent is a pet-art id', () => {
        const roster = [...Object.keys(PET_DEFINITIONS), ...WILD_PET_IDS];
        // No omissions and no extras: the literal list and the roster are the same set.
        expect([...PET_SPECIES_IDS].sort()).toEqual([...new Set(roster)].sort());
    });

    test('petItemId, the set, and the guard all agree', () => {
        for (const id of PET_SPECIES_IDS) {
            expect(petItemId(id)).toBe(`pet:${id}`);
            expect(PET_ITEM_IDS.has(`pet:${id}`)).toBe(true);
            expect(isPetItemId(`pet:${id}`)).toBe(true);
        }
        expect(PET_ITEM_IDS.size).toBe(PET_SPECIES_IDS.length);
        expect(isPetItemId('pet:not_a_species')).toBe(false);
        expect(isPetItemId('dog')).toBe(false);
    });

    test('every pet key passes the image route\'s shape check', () => {
        const malformed = [...PET_ITEM_IDS].filter(id => !ROUTE_ID_SHAPE.test(id));
        expect(malformed).toEqual([]);
    });
});

describe('pet art is bundle-only, not uploadable', () => {
    test('no pet key is accepted by the upload route', () => {
        for (const id of PET_ITEM_IDS) {
            expect(isUploadableItemId(id)).toBe(false);
        }
    });

    test('pet keys never collide with a gear or result id', () => {
        for (const id of PET_ITEM_IDS) {
            expect(ACTIVITY_ITEM_IDS.has(id)).toBe(false);
            expect(RESULT_ITEM_IDS.has(id)).toBe(false);
        }
    });
});

describe('the icon manifest covers every pet', () => {
    const petEntries = manifest.filter(m => m.key.startsWith('pet:'));

    test('exactly one manifest entry per pet species, and none stray', () => {
        expect(petEntries.map(m => m.key).sort()).toEqual([...PET_ITEM_IDS].sort());
    });

    test('every pet entry carries a portrait prompt, rarity and rim', () => {
        for (const m of petEntries) {
            expect(m.prompt).toMatch(/^Pet portrait icon: /);
            expect(m.prompt).toContain('rarity rim,');
            expect(typeof m.rarity).toBe('string');
            expect(m.rim.length).toBeGreaterThan(0);
            expect(m.file).toBe(`${m.key.replace(/:/g, '__')}.png`);
        }
    });
});
