'use strict';

// Crafting materials get baked icon art (#1168), keyed in
// src/data/activityItems.js under `<activity>:<id>` — the key the inventory
// cards already ask for. Three things have to stay true or a material ships
// with no art slot, or with art under a key nothing reads: the registry must
// track materialRarity.js, no material may share a key with gear, a result, a
// pet or an explore region, and every game whose art has been generated must
// have a manifest prompt for each of its materials.
//
// Material art is *bundle-only*, the call #1080 made for pets: no dashboard
// panel lists materials, so the upload route must not accept these keys.

const {
    MATERIAL_SOURCES, MATERIAL_ITEMS, MATERIAL_ITEM_IDS, materialItemId, isMaterialItemId,
    isUploadableItemId, ACTIVITY_ITEM_IDS, RESULT_ITEM_IDS, PET_ITEM_IDS, EXPLORE_ITEM_IDS,
} = require('../src/data/activityItems');
const { MATERIAL_RARITY } = require('../src/data/materialRarity');
const fish = require('../src/data/fishData');
const manifest = require('../assets/icons/manifest.json');

const ROUTE_ID_SHAPE = /^[a-z0-9_:-]{1,64}$/;
const TIER_RARITY = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];

describe('the material art roster tracks materialRarity.js', () => {
    test('every material has exactly one key, under its own activity', () => {
        const expected = Object.entries(MATERIAL_RARITY).map(([id, def]) => `${def.source}:${id}`);
        expect([...MATERIAL_ITEM_IDS].sort()).toEqual(expected.sort());
        expect(MATERIAL_ITEM_IDS.size).toBe(Object.values(MATERIAL_ITEMS).flat().length);
        for (const source of Object.keys(MATERIAL_ITEMS)) expect(MATERIAL_SOURCES).toContain(source);
    });

    test('the key is the one the /fish inv card asks for', () => {
        // profile.js builds `fish:${id}` for each material it lists.
        for (const id of Object.keys(fish.MATERIAL_NAMES)) {
            expect(materialItemId('fish', id)).toBe(`fish:${id}`);
            expect(isMaterialItemId(`fish:${id}`)).toBe(true);
        }
        expect(isMaterialItemId('pearl')).toBe(false);
        expect(isMaterialItemId('fish:not_a_material')).toBe(false);
    });

    test('every material key passes the image route\'s shape check', () => {
        expect([...MATERIAL_ITEM_IDS].filter(id => !ROUTE_ID_SHAPE.test(id))).toEqual([]);
    });
});

describe('material art is bundle-only, and its own', () => {
    test('no material key is accepted by the upload route', () => {
        for (const id of MATERIAL_ITEM_IDS) expect(isUploadableItemId(id)).toBe(false);
    });

    test('no material key collides with gear, a result, a pet or an explore region', () => {
        // The baked art is looked up by key alone, so a shared key would put
        // one item's picture on the other.
        for (const id of MATERIAL_ITEM_IDS) {
            expect([id, ACTIVITY_ITEM_IDS.has(id)]).toEqual([id, false]);
            expect([id, RESULT_ITEM_IDS.has(id)]).toEqual([id, false]);
            expect([id, PET_ITEM_IDS.has(id)]).toEqual([id, false]);
            expect([id, EXPLORE_ITEM_IDS.has(id)]).toEqual([id, false]);
        }
    });
});

describe('the icon manifest covers the fishing materials (#1169)', () => {
    const fishMaterialKeys = MATERIAL_ITEMS.fish.map(item => item.id);
    const entries = manifest.filter(m => fishMaterialKeys.includes(m.key));

    test('exactly one entry per fishing material', () => {
        expect(entries.map(m => m.key).sort()).toEqual([...fishMaterialKeys].sort());
    });

    test('each takes its rim from the material\'s tier', () => {
        for (const m of entries) {
            const id = m.key.slice('fish:'.length);
            expect([m.key, m.rarity]).toEqual([m.key, TIER_RARITY[MATERIAL_RARITY[id].tier - 1]]);
            expect(m.prompt).toMatch(/^Game item icon: /);
            expect(m.prompt).toContain('rarity rim,');
            expect(m.file).toBe(`${m.key.replace(/:/g, '__')}.png`);
        }
    });

    test('the three scales share one silhouette (STYLE.md §4)', () => {
        const scales = ['fish:fish_scale', 'fish:rare_scale', 'fish:mythic_scale']
            .map(key => entries.find(m => m.key === key).prompt);
        const base = 'a single large teardrop-shaped fish scale standing upright';
        for (const prompt of scales) expect(prompt).toContain(base);
    });
});
