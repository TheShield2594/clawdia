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

describe('the icon manifest covers the mining materials (#1170)', () => {
    const mineMaterialKeys = MATERIAL_ITEMS.mine.map(item => item.id);
    const entries = manifest.filter(m => mineMaterialKeys.includes(m.key));

    test('exactly one entry per mining material', () => {
        expect(entries.map(m => m.key).sort()).toEqual([...mineMaterialKeys].sort());
    });

    test('each takes its rim from the material\'s tier', () => {
        for (const m of entries) {
            const id = m.key.slice('mine:'.length);
            expect([m.key, m.rarity]).toEqual([m.key, TIER_RARITY[MATERIAL_RARITY[id].tier - 1]]);
            expect(m.prompt).toMatch(/^Game item icon: /);
            expect(m.prompt).toContain('rarity rim,');
            expect(m.file).toBe(`${m.key.replace(/:/g, '__')}.png`);
        }
    });

    test('the dusts and the raw gems each share one silhouette (STYLE.md §4)', () => {
        const prompt = key => entries.find(m => m.key === key).prompt;
        for (const id of ['coal_dust', 'silver_dust', 'platinum_dust', 'mythril_dust']) {
            expect(prompt(`mine:${id}`)).toContain('a small conical heap of fine glittering powder');
        }
        for (const id of ['raw_sapphire', 'raw_emerald', 'raw_ruby', 'raw_diamond']) {
            expect(prompt(`mine:${id}`)).toContain('a single rough uncut gemstone with jagged natural facets');
        }
    });
});

describe('the icon manifest covers the hunting materials (#1171)', () => {
    const huntMaterialKeys = MATERIAL_ITEMS.hunt.map(item => item.id);
    const entries = manifest.filter(m => huntMaterialKeys.includes(m.key));

    test('exactly one entry per hunting material', () => {
        expect(huntMaterialKeys).toHaveLength(58);
        expect(entries.map(m => m.key).sort()).toEqual([...huntMaterialKeys].sort());
    });

    test('each takes its rim from the material\'s tier', () => {
        for (const m of entries) {
            const id = m.key.slice('hunt:'.length);
            expect([m.key, m.rarity]).toEqual([m.key, TIER_RARITY[MATERIAL_RARITY[id].tier - 1]]);
            expect(m.prompt).toMatch(/^Game item icon: /);
            expect(m.prompt).toContain('rarity rim,');
            expect(m.file).toBe(`${m.key.replace(/:/g, '__')}.png`);
        }
    });

    test('like kinds share one silhouette (STYLE.md §4)', () => {
        const prompt = key => entries.find(m => m.key === key).prompt;
        const shared = {
            'a single soft animal pelt laid out flat': ['badger_pelt', 'beaver_pelt', 'wolf_pelt', 'spirit_pelt',
                'striped_pelt', 'opossum_pelt', 'sand_pelt', 'arctic_fox_pelt', 'shadow_pelt'],
            'a single long feather angled diagonally': ['feather', 'crow_feather', 'scavenger_feather',
                'snowy_feather', 'marsh_feather', 'storm_feather', 'thunderfeather'],
            'a single long curved pointed fang': ['coyote_fang', 'lynx_fang', 'hyena_fang', 'saber_fang',
                'dire_wolf_fang', 'ember_fang'],
            'a single large hooked claw': ['bear_claw', 'ancient_claw', 'polar_claw', 'primal_claw'],
            'a single branching antler': ['elk_antler', 'caribou_antler', 'obsidian_antler'],
            'a single thick ridged horn': ['mountain_horn', 'ram_horn'],
            'a single smooth curved tusk': ['hog_tusk', 'mammoth_tusk'],
            'a single furry lucky animal foot charm': ['rabbits_foot', 'jackrabbit_foot'],
        };
        for (const [base, ids] of Object.entries(shared)) {
            for (const id of ids) expect(prompt(`hunt:${id}`)).toContain(base);
        }
    });
});

describe('the icon manifest covers the exploration materials (#1172)', () => {
    const exploreMaterialKeys = MATERIAL_ITEMS.explore.map(item => item.id);
    const entries = manifest.filter(m => exploreMaterialKeys.includes(m.key));

    test('exactly one entry per exploration material', () => {
        expect(exploreMaterialKeys).toHaveLength(11);
        expect(entries.map(m => m.key).sort()).toEqual([...exploreMaterialKeys].sort());
    });

    test('each takes its rim from the material\'s tier', () => {
        for (const m of entries) {
            const id = m.key.slice('explore:'.length);
            expect([m.key, m.rarity]).toEqual([m.key, TIER_RARITY[MATERIAL_RARITY[id].tier - 1]]);
            expect(m.prompt).toMatch(/^Game item icon: /);
            expect(m.prompt).toContain('rarity rim,');
            expect(m.file).toBe(`${m.key.replace(/:/g, '__')}.png`);
        }
    });
});
