'use strict';

// The catalog in data/activityItems.js is what the image upload route validates
// against (#561), so an id the game renders and the catalog omits is an image
// nobody can upload — which is exactly what happened to the zone, location and
// depth cards: the shop views ask for an image for each of them, and the first
// version of the catalog listed only gear, upgrades, packs and consumables.
//
// Two kinds of check, because the first alone would not have caught that: the
// ids each source list produces are in the catalog, and the *number of groups*
// the catalog carries matches the number of image slots the shop view actually
// draws. The second is the drift guard — a sixth group added to a shop view
// fails here rather than silently becoming un-uploadable.

const fs = require('fs');
const path = require('path');
const { grindCommandFiles } = require('./helpers/grindSources');

const { ACTIVITY_ITEMS, ACTIVITY_ITEM_IDS, isActivityItemId } = require('../src/data/activityItems');
const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES, ZONE_LIST } = require('../src/data/huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES, LOCATION_LIST } = require('../src/data/fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES, DEPTH_LIST } = require('../src/data/mineData');

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
        ['fish rods',        'fish', slugs(ROD_TIERS)],
        ['fish upgrades',    'fish', ids(Object.values(ROD_UPGRADES))],
        ['fish bait',        'fish', ids(BAIT_PACKS)],
        ['fish consumables', 'fish', ids(Object.values(FISH_CONSUMABLES))],
        ['fish locations',   'fish', ids(LOCATION_LIST)],
        ['mine pickaxes',    'mine', slugs(PICKAXE_TIERS)],
        ['mine upgrades',    'mine', ids(Object.values(PICKAXE_UPGRADES))],
        ['mine blasts',      'mine', ids(BLAST_PACKS)],
        ['mine consumables', 'mine', ids(Object.values(MINE_CONSUMABLES))],
        ['mine depths',      'mine', ids(DEPTH_LIST)],
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

// The drift guard. Each `imageId:` in a shop view is a slot the browse UI draws
// an image into; each group in the catalog is a set of ids that may fill one.
// The counts have to match, or some slot is rendering an id nothing can upload.
describe('the catalog covers every image slot the shop views draw', () => {
    // Every file of the grind command, not just the shop's: the shop group is a
    // folder of its own since #917, and a check that read `<name>/shop.js` would
    // now read nothing at all.
    const shopSource = activity => grindCommandFiles(activity)
        .filter(f => f.split(path.sep).includes('shop'))
        .map(f => fs.readFileSync(f, 'utf8'))
        .join('\n');

    test.each(['hunt', 'fish', 'mine'])('%s', activity => {
        const slots = shopSource(activity).match(new RegExp(`imageId:\\s*\`${activity}:`, 'g')) || [];
        expect(slots.length).toBeGreaterThan(0);
        expect(Object.keys(ACTIVITY_ITEMS[activity])).toHaveLength(slots.length);
    });
});
