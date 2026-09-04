'use strict';

/**
 * The `itemId` a guild shop item's image is stored under in `itemimages` (#888).
 *
 * Shop images used to live inline on the guild document, as `Buffer`s on
 * `guild.shop[].imageData` — an unbounded array of up to ~512 KB blobs inside
 * the settings document every message path reads. Three things came out of
 * that: a 16 MB BSON ceiling an illustrated shop walks toward, an upload route
 * that loaded and rewrote the whole document (racing every concurrent settings
 * write), and a projection every reader had to remember or pay megabytes for.
 * They live in the `ItemImage` collection now, beside the activity images that
 * were already there, so an upload is a targeted `$set` on one small document.
 *
 * That collection is keyed `{ guildId, itemId }`, and it already holds the
 * hunt/fish/mine catalog under ids of the form `hunt:wooden_rifle`. A guild's
 * shop item ids are whatever an admin typed — `padlock`, and nothing stops
 * `hunt:wooden_rifle` — so shop images carry their own namespace rather than
 * sharing the key space. Without it an admin who names a shop item after an
 * activity item replaces that guild's activity icon by uploading a shop one,
 * which is a small version of the cross-guild bug #561 closed.
 *
 * The prefix is not a display concern and never reaches a player: it is the
 * storage key, applied at the boundary in the routes and the two lookup helpers.
 *
 * It lives beside the model rather than under utils/ because migration 022 has
 * to form the same keys, and a migration is in the lowest layer — it may not
 * reach up into utils (see eslint-rules/layer-boundaries.js). The key space of a
 * collection belongs with the collection anyway.
 */

const SHOP_IMAGE_PREFIX = 'shop:';

/** The storage key for a shop item's image. */
function shopImageId(itemId) {
    return `${SHOP_IMAGE_PREFIX}${itemId}`;
}

/** Whether a stored key names a shop image rather than an activity one. */
function isShopImageId(key) {
    return typeof key === 'string' && key.startsWith(SHOP_IMAGE_PREFIX);
}

/** The shop item id behind a storage key, or null if it is not one of ours. */
function shopItemIdOf(key) {
    return isShopImageId(key) ? key.slice(SHOP_IMAGE_PREFIX.length) : null;
}

module.exports = { SHOP_IMAGE_PREFIX, shopImageId, isShopImageId, shopItemIdOf };
