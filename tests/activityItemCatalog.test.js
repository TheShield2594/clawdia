'use strict';

// The catalog in data/activityItems.js is what the image upload route validates
// against (#561), so an id the game renders and the catalog omits is an image
// nobody can upload — which is exactly what happened to the zone, location and
// depth cards: the shop views ask for an image for each of them, and the first
// version of the catalog listed only gear, upgrades, packs and consumables.
//
// Two kinds of check, because the first alone would not have caught that: the
// ids each source list produces are in the catalog, and every group the catalog
// carries is named by something that renders it. The second is the drift guard,
// and it now runs both ways — a group added to a shop view or a result embed
// without reaching the catalog is an image nobody can upload, and a group in
// the catalog that nothing draws is storage bought for nothing.

const fs = require('fs');
const path = require('path');

const { ACTIVITY_ITEMS, ACTIVITY_ITEM_IDS, isActivityItemId } = require('../src/data/activityItems');
const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES, ZONE_LIST, ANIMALS } = require('../src/data/huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES, LOCATION_LIST, FISH, JUNK_ITEMS, TREASURE_ITEMS } = require('../src/data/fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES, DEPTH_LIST, ORES } = require('../src/data/mineData');
const { MATERIAL_RARITY } = require('../src/data/materialRarity');

// The shape the upload route requires of an id before it even reaches the
// catalog. A catalog entry that cannot pass it is unreachable.
const ROUTE_ID_SHAPE = /^[a-z0-9_:-]{1,64}$/;

const ids = list => list.map(item => item.id);
const slugs = list => list.map(item => item.slug);

describe('every id the shop views render is in the catalog', () => {
    const cases = [
        ['hunt weapons',     'hunt', slugs(WEAPON_TIERS)],
        ['hunt upgrades',    'hunt', ids(Object.values(WEAPON_UPGRADES))],
        ['hunt ammo',        'hunt', ids(AMMO_PACKS)],
        ['hunt consumables', 'hunt', ids(Object.values(HUNT_CONSUMABLES))],
        ['hunt zones',       'hunt', ids(ZONE_LIST)],
        ['hunt animals',     'hunt', ids(Object.values(ANIMALS))],
        ['fish rods',        'fish', slugs(ROD_TIERS)],
        ['fish upgrades',    'fish', ids(Object.values(ROD_UPGRADES))],
        ['fish bait',        'fish', ids(BAIT_PACKS)],
        ['fish consumables', 'fish', ids(Object.values(FISH_CONSUMABLES))],
        ['fish locations',   'fish', ids(LOCATION_LIST)],
        ['fish catches',     'fish', ids(Object.values(FISH))],
        ['fish junk',        'fish', ids(JUNK_ITEMS)],
        ['fish treasure',    'fish', ids(TREASURE_ITEMS)],
        ['mine pickaxes',    'mine', slugs(PICKAXE_TIERS)],
        ['mine upgrades',    'mine', ids(Object.values(PICKAXE_UPGRADES))],
        ['mine blasts',      'mine', ids(BLAST_PACKS)],
        ['mine consumables', 'mine', ids(Object.values(MINE_CONSUMABLES))],
        ['mine depths',      'mine', ids(DEPTH_LIST)],
        ['mine ores',        'mine', ids(Object.values(ORES))],
        ['materials',        'material', Object.keys(MATERIAL_RARITY)],
    ];

    test.each(cases)('%s', (_label, namespace, memberIds) => {
        expect(memberIds.length).toBeGreaterThan(0);
        const missing = memberIds.filter(id => !isActivityItemId(`${namespace}:${id}`));
        expect(missing).toEqual([]);
    });

    test('every catalog id can pass the upload route\'s own shape check', () => {
        const malformed = [...ACTIVITY_ITEM_IDS].filter(id => !ROUTE_ID_SHAPE.test(id));
        expect(malformed).toEqual([]);
    });

    test('ids are unique across the whole catalog', () => {
        const all = Object.values(ACTIVITY_ITEMS).flatMap(groups => Object.values(groups)).flat();
        expect(ACTIVITY_ITEM_IDS.size).toBe(all.length);
    });
});

// The drift guard, in the form the catalog outgrew. It used to compare each
// namespace's group count against the `imageId:` slots in that activity's shop
// view, on the assumption that the shop was the only thing that drew an item —
// which stopped being true when the catches and materials arrived, drawn by the
// result embeds and by `/inventory` instead.
//
// So the guard is now a table: every group in the catalog names the file that
// renders it and the expression that file asks for it by. A group with no
// render site is 512 KB per id of storage bought for nothing, and a group
// missing from the table fails the last test here rather than slipping in.
describe('every catalog group is rendered by something', () => {
    const RENDER_SITES = [
        ['hunt.weapons',      'hunt/shop.js',       'imageId: `hunt:${w.slug}`'],
        ['hunt.upgrades',     'hunt/shop.js',       'imageId: `hunt:${u.id}`'],
        ['hunt.ammo',         'hunt/shop.js',       'imageId: `hunt:${a.id}`'],
        ['hunt.consumables',  'hunt/shop.js',       'imageId: `hunt:${c.id}`'],
        ['hunt.zones',        'hunt/shop.js',       'imageId: `hunt:${z.id}`'],
        ['hunt.animals',      'hunt/start.js',      '`hunt:${result.animal.id}`'],
        ['fish.rods',         'fish/shop.js',       'imageId: `fish:${r.slug}`'],
        ['fish.upgrades',     'fish/shop.js',       'imageId: `fish:${u.id}`'],
        ['fish.bait',         'fish/shop.js',       'imageId: `fish:${p.id}`'],
        ['fish.consumables',  'fish/shop.js',       'imageId: `fish:${c.id}`'],
        ['fish.locations',    'fish/shop.js',       'imageId: `fish:${loc.id}`'],
        // One expression covers all three: a cast resolves the fish, the junk or
        // the treasure into `caught`, whichever it reeled in.
        ['fish.fish',         'fish/cast.js',       '`fish:${caught.id}`'],
        ['fish.junk',         'fish/cast.js',       '`fish:${caught.id}`'],
        ['fish.treasure',     'fish/cast.js',       '`fish:${caught.id}`'],
        ['mine.pickaxes',     'mine/shop.js',       'imageId: `mine:${p.slug}`'],
        ['mine.upgrades',     'mine/shop.js',       'imageId: `mine:${u.id}`'],
        ['mine.blasts',       'mine/shop.js',       'imageId: `mine:${b.id}`'],
        ['mine.consumables',  'mine/shop.js',       'imageId: `mine:${c.id}`'],
        ['mine.depths',       'mine/shop.js',       'imageId: `mine:${d.id}`'],
        ['mine.ores',         'mine/dig.js',        '`mine:${result.ore.id}`'],
        ['material.hunt',     'inventory.js',       '`material:${best.key}`'],
        ['material.fish',     'inventory.js',       '`material:${best.key}`'],
        ['material.mine',     'inventory.js',       '`material:${best.key}`'],
        ['material.explore',  'inventory.js',       '`material:${best.key}`'],
    ];

    const commandFile = rel => fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', rel), 'utf8');

    test.each(RENDER_SITES)('%s is asked for in %s', (group, rel, expression) => {
        const [namespace, name] = group.split('.');
        expect(ACTIVITY_ITEMS[namespace]?.[name]?.length).toBeGreaterThan(0);
        expect(commandFile(rel)).toContain(expression);
    });

    test('names a render site for every group in the catalog', () => {
        const groups = Object.entries(ACTIVITY_ITEMS)
            .flatMap(([namespace, names]) => Object.keys(names).map(name => `${namespace}.${name}`));

        expect(groups.sort()).toEqual(RENDER_SITES.map(([group]) => group).sort());
    });
});
