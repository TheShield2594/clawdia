'use strict';

// MATERIAL_RARITY is what /inventory's material tabs, the collection count,
// /showcase, the public profile and pet feeding read. A material a grind can
// drop but this table does not list is invisible in all of them — which is how
// 32 hunt zone materials went missing from /inventory. These tests tie the
// table to each system's own material list so it cannot drift again.

const { MATERIAL_RARITY, TIER_LABELS } = require('../src/data/materialRarity');
const huntData = require('../src/data/huntData');
const fishData = require('../src/data/fishData');
const mineData = require('../src/data/mineData');
const { TREASURE_MATERIALS } = require('../src/data/exploreData');

const idsFrom = source => Object.entries(MATERIAL_RARITY).filter(([, d]) => d.source === source).map(([id]) => id);

describe.each([
    ['hunt', huntData.MATERIAL_NAMES],
    ['fish', fishData.MATERIAL_NAMES],
    ['mine', mineData.MATERIAL_NAMES],
])('%s materials', (source, names) => {
    test('every material the system names has an entry with its source', () => {
        const missing = Object.keys(names).filter(id => MATERIAL_RARITY[id]?.source !== source);
        expect(missing).toEqual([]);
    });

    test('every entry for the source is a material the system names', () => {
        expect(idsFrom(source).filter(id => !(id in names))).toEqual([]);
    });
});

test('every hunt animal, fish and ore special drop resolves to a material', () => {
    const drops = [
        ...Object.values(huntData.ANIMALS).map(a => a.specialDrop?.itemId),
        ...Object.values(fishData.FISH).map(f => f.specialDrop?.itemId),
        ...Object.values(mineData.ORES).map(o => o.specialDrop?.itemId),
    ].filter(Boolean);
    expect(drops.filter(id => !MATERIAL_RARITY[id])).toEqual([]);
});

test('every tier a treasure can roll has explore materials to give', () => {
    const exploreTiers = new Set(idsFrom('explore').map(id => MATERIAL_RARITY[id].tier));
    for (const { tiers } of Object.values(TREASURE_MATERIALS)) {
        for (const tier of tiers) expect(exploreTiers.has(tier)).toBe(true);
    }
});

test('every entry has a label, an emoji and a material tier', () => {
    for (const [id, d] of Object.entries(MATERIAL_RARITY)) {
        expect({ id, ok: Boolean(d.label && d.emoji && TIER_LABELS[d.tier] && d.tier <= 5) }).toEqual({ id, ok: true });
    }
});
