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
 */

const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES } = require('./huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES } = require('./fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES } = require('./mineData');

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

const ACTIVITY_ITEMS = {
    hunt: {
        weapons:     WEAPON_TIERS.map(w => toItem('hunt', w, 'slug')),
        upgrades:    Object.values(WEAPON_UPGRADES).map(u => toItem('hunt', u)),
        ammo:        AMMO_PACKS.map(a => toItem('hunt', a)),
        consumables: Object.values(HUNT_CONSUMABLES).map(c => toItem('hunt', c)),
    },
    fish: {
        rods:        ROD_TIERS.map(r => toItem('fish', r, 'slug')),
        upgrades:    Object.values(ROD_UPGRADES).map(u => toItem('fish', u)),
        bait:        BAIT_PACKS.map(b => toItem('fish', b)),
        consumables: Object.values(FISH_CONSUMABLES).map(c => toItem('fish', c)),
    },
    mine: {
        pickaxes:    PICKAXE_TIERS.map(p => toItem('mine', p, 'slug')),
        upgrades:    Object.values(PICKAXE_UPGRADES).map(u => toItem('mine', u)),
        blasts:      BLAST_PACKS.map(b => toItem('mine', b)),
        consumables: Object.values(MINE_CONSUMABLES).map(c => toItem('mine', c)),
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
