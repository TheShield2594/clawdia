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
 * Which makes the list's completeness load-bearing: an id the shop renders and
 * this file omits is an image nobody can upload. So the groups here are every
 * group the `/hunt shop`, `/fish shop` and `/mine shop` browse views ask for an
 * image by — gear, upgrades, packs and consumables, *and* the zones, locations
 * and depths those views also draw. The panel renders a subset of these; the
 * route validates against all of them.
 *
 * The catch/kill/mine *results* — caught fish, hunted animals, mined ores — are
 * a second, parallel registry below (`RESULT_ITEMS`). They are not shop items
 * (you can't browse or buy a fish species), so they are kept out of
 * `ACTIVITY_ITEMS` — which stays the shop catalog the dashboard panel renders —
 * and given their own namespaces (`fishcatch:`, `animal:`, `ore:`) distinct from
 * the gear namespaces (`fish:`, `hunt:`, `mine:`). The upload route accepts an id
 * that is in *either* registry (`isUploadableItemId`), so custom art for a result
 * can be uploaded and the bundled catalogue can ship default art for it, while
 * the shop-panel contract — the panel can only offer ids the route accepts —
 * still holds for the ids the panel actually offers.
 */

const { WEAPON_TIERS, AMMO_PACKS, CONSUMABLES: HUNT_CONSUMABLES, WEAPON_UPGRADES, ZONE_LIST, ANIMALS } = require('./huntData');
const { ROD_TIERS, BAIT_PACKS, CONSUMABLES: FISH_CONSUMABLES, ROD_UPGRADES, LOCATION_LIST, FISH } = require('./fishData');
const { PICKAXE_TIERS, BLAST_PACKS, CONSUMABLES: MINE_CONSUMABLES, PICKAXE_UPGRADES, DEPTH_LIST, ORES } = require('./mineData');

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
        zones:       ZONE_LIST.map(z => toItem('hunt', z)),
    },
    fish: {
        rods:        ROD_TIERS.map(r => toItem('fish', r, 'slug')),
        upgrades:    Object.values(ROD_UPGRADES).map(u => toItem('fish', u)),
        bait:        BAIT_PACKS.map(b => toItem('fish', b)),
        consumables: Object.values(FISH_CONSUMABLES).map(c => toItem('fish', c)),
        locations:   LOCATION_LIST.map(l => toItem('fish', l)),
    },
    mine: {
        pickaxes:    PICKAXE_TIERS.map(p => toItem('mine', p, 'slug')),
        upgrades:    Object.values(PICKAXE_UPGRADES).map(u => toItem('mine', u)),
        blasts:      BLAST_PACKS.map(b => toItem('mine', b)),
        consumables: Object.values(MINE_CONSUMABLES).map(c => toItem('mine', c)),
        depths:      DEPTH_LIST.map(d => toItem('mine', d)),
    },
};

const ACTIVITY_ITEM_IDS = new Set(
    Object.values(ACTIVITY_ITEMS)
        .flatMap(groups => Object.values(groups))
        .flat()
        .map(item => item.id)
);

/** Whether `itemId` names a shop-browsable activity item that exists in the game data. */
function isActivityItemId(itemId) {
    return typeof itemId === 'string' && ACTIVITY_ITEM_IDS.has(itemId);
}

// ─── RESULT ITEMS (caught fish, hunted animals, mined ores) ────────────────────
//
// The things a `/fish cast`, `/hunt start` or `/mine dig` produces. They are not
// gear and not shop items, so they carry their own namespace, distinct from the
// gear one, and never collide with a gear id even when a species and a tier share
// a slug. Fish/animals/ores are all keyed by their `id` field.
const RESULT_NAMESPACES = { fish: 'fishcatch', hunt: 'animal', mine: 'ore' };

/** The storage key an activity's result is filed under (`fishcatch:minnow`, …). */
function resultItemId(activity, id) {
    const ns = RESULT_NAMESPACES[activity];
    return ns ? `${ns}:${id}` : null;
}

const RESULT_ITEMS = {
    fish:    Object.values(FISH).map(f => toItem('fishcatch', f)),
    animals: Object.values(ANIMALS).map(a => toItem('animal', a)),
    ores:    Object.values(ORES).map(o => toItem('ore', o)),
};

const RESULT_ITEM_IDS = new Set(
    Object.values(RESULT_ITEMS)
        .flat()
        .map(item => item.id)
);

/** Whether `itemId` names a catch/kill/mine result that exists in the game data. */
function isResultItemId(itemId) {
    return typeof itemId === 'string' && RESULT_ITEM_IDS.has(itemId);
}

/**
 * Whether `itemId` is an id the image upload route may accept — a shop-browsable
 * activity item or a catch/kill/mine result. This is the check that bounds what
 * the `itemimages` collection can store under an activity/result key.
 */
function isUploadableItemId(itemId) {
    return isActivityItemId(itemId) || isResultItemId(itemId);
}

// ─── PET SPECIES (companion portrait art) ─────────────────────────────────────
//
// Pets are a fixed roster with their own art (issue #1082): the ten ownable
// species in petService's PET_DEFINITIONS plus the four wild battle opponents
// makeWildPet fields. /pet renders each as a portrait thumbnail via
// getItemImageAttachment(petItemId(id), …), falling back to the species emoji.
//
// Unlike gear and results, pet art is *bundle-only*. The roster is fixed and
// there is no dashboard panel to upload against, so — following the decision in
// #1080 to make the bundled catalogue authoritative — pet keys are deliberately
// kept out of isUploadableItemId: nothing may store a per-guild pet image, and
// the only source of pet art is the baked default set (defaultItemImages.js).
//
// The ids live here as a literal because this file is pure data (requiring
// petService would pull in the Mongoose models, and assets/icons/build-manifest.mjs
// requires this file under a bare `node`). A test asserts the literal stays in
// step with petService's PET_DEFINITIONS + WILD_PET_IDS, so a new species can't
// silently ship with no art slot.
const PET_NAMESPACE = 'pet';
const PET_SPECIES_IDS = [
    // ownable companions (PET_DEFINITIONS)
    'dog', 'cat', 'bird', 'fish', 'fox', 'wolf',
    'eagle', 'shark', 'crystal_fox', 'lantern_owl',
    // wild battle opponents (makeWildPet)
    'wild_boar', 'feral_cat', 'stray_hound', 'cave_bat',
];

/** The storage key a pet species' art is filed under (`pet:crystal_fox`). */
function petItemId(petId) {
    return `${PET_NAMESPACE}:${petId}`;
}

const PET_ITEM_IDS = new Set(PET_SPECIES_IDS.map(petItemId));

/** Whether `itemId` names a pet species the bundled art set covers. */
function isPetItemId(itemId) {
    return typeof itemId === 'string' && PET_ITEM_IDS.has(itemId);
}

module.exports = {
    ACTIVITY_ITEMS, ACTIVITY_ITEM_IDS, isActivityItemId,
    RESULT_ITEMS, RESULT_ITEM_IDS, RESULT_NAMESPACES, resultItemId,
    isResultItemId, isUploadableItemId,
    PET_NAMESPACE, PET_SPECIES_IDS, PET_ITEM_IDS, petItemId, isPetItemId,
};
