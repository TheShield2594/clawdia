'use strict';

/**
 * The canonical list of hunt/fish/mine items the dashboard can attach an image
 * to, derived from the game data rather than restated beside it.
 *
 * The dashboard panel already built this list to render its item cards. It is
 * pulled out here because the upload route needs the same list for a different
 * reason: the item id used to be free text matching `[a-z0-9_:-]{1,64}`, so a
 * caller could store an image under any id they liked, forever, at 512 KB a
 * time. Bounding writes to ids the game actually reads turns "how much can be
 * stored" from a question about the caller's patience into a property of this
 * file.
 *
 * Which makes the list's completeness load-bearing: an id a command renders and
 * this file omits is an image nobody can upload. So the groups here are every
 * group something asks an image for — the gear, upgrades, packs, consumables,
 * zones, locations and depths the three shop browse views draw, and the catches
 * and materials the activities themselves draw: an animal, a fish, a piece of
 * junk, a treasure, an ore, and the crafting materials all four grind systems
 * drop.
 *
 * Catches and materials were left out at first because nothing rendered them —
 * a catch was a title and an emoji on the result embed, and a material was a
 * line of text. They are in now because those embeds ask for a thumbnail (see
 * `attachItemThumbnail`), and a group nothing renders is worse than useless:
 * it is 512 KB per id of storage bought for nothing. The pairing is the rule
 * this file lives by — a group is added here when a render site asks for it,
 * and `tests/activityItemCatalog.test.js` names the site for every group.
 */

const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES, ZONE_LIST, ANIMALS } = require('./huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES, LOCATION_LIST, FISH, JUNK_ITEMS, TREASURE_ITEMS } = require('./fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES, DEPTH_LIST, ORES } = require('./mineData');
const { MATERIAL_RARITY } = require('./materialRarity');

// Tiered gear is keyed by `slug`; everything else by `id`. That difference is
// in the game data, so it is honoured here rather than normalised away — the
// ids these produce are the ones the commands ask for at render time.
function toItem(namespace, item, idField = 'id') {
    return {
        id: `${namespace}:${item[idField]}`,
        label: item.name,
        emoji: item.emoji || '📦',
    };
}

// Materials are the one collection that is not owned by a single activity: a
// hunt trophy is an ingredient in a fishing recipe, and `MATERIAL_RARITY` keys
// them in one flat space precisely so a recipe can name one without saying
// where it came from. So they get a namespace of their own rather than being
// filed under whichever activity happens to drop them, and the `source` field
// only groups them for display.
function toMaterial([id, meta]) {
    return { id: `material:${id}`, label: meta.label, emoji: meta.emoji || '📦' };
}

const materialsFrom = source =>
    Object.entries(MATERIAL_RARITY).filter(([, meta]) => meta.source === source).map(toMaterial);

const ACTIVITY_ITEMS = {
    hunt: {
        weapons:     WEAPON_TIERS.map(w => toItem('hunt', w, 'slug')),
        upgrades:    Object.values(WEAPON_UPGRADES).map(u => toItem('hunt', u)),
        ammo:        AMMO_PACKS.map(a => toItem('hunt', a)),
        consumables: Object.values(HUNT_CONSUMABLES).map(c => toItem('hunt', c)),
        zones:       ZONE_LIST.map(z => toItem('hunt', z)),
        animals:     Object.values(ANIMALS).map(a => toItem('hunt', a)),
    },
    fish: {
        rods:        ROD_TIERS.map(r => toItem('fish', r, 'slug')),
        upgrades:    Object.values(ROD_UPGRADES).map(u => toItem('fish', u)),
        bait:        BAIT_PACKS.map(b => toItem('fish', b)),
        consumables: Object.values(FISH_CONSUMABLES).map(c => toItem('fish', c)),
        locations:   LOCATION_LIST.map(l => toItem('fish', l)),
        fish:        Object.values(FISH).map(f => toItem('fish', f)),
        junk:        JUNK_ITEMS.map(j => toItem('fish', j)),
        treasure:    TREASURE_ITEMS.map(t => toItem('fish', t)),
    },
    mine: {
        pickaxes:    PICKAXE_TIERS.map(p => toItem('mine', p, 'slug')),
        upgrades:    Object.values(PICKAXE_UPGRADES).map(u => toItem('mine', u)),
        blasts:      BLAST_PACKS.map(b => toItem('mine', b)),
        consumables: Object.values(MINE_CONSUMABLES).map(c => toItem('mine', c)),
        depths:      DEPTH_LIST.map(d => toItem('mine', d)),
        ores:        Object.values(ORES).map(o => toItem('mine', o)),
    },
    material: {
        hunt:    materialsFrom('hunt'),
        fish:    materialsFrom('fish'),
        mine:    materialsFrom('mine'),
        explore: materialsFrom('explore'),
    },
};

const ACTIVITY_ITEM_IDS = new Set(
    Object.values(ACTIVITY_ITEMS)
        .flatMap(groups => Object.values(groups))
        .flat()
        .map(item => item.id)
);

/** Whether `itemId` names an activity item that exists in the game data. */
function isActivityItemId(itemId) {
    return typeof itemId === 'string' && ACTIVITY_ITEM_IDS.has(itemId);
}

module.exports = { ACTIVITY_ITEMS, ACTIVITY_ITEM_IDS, isActivityItemId };
