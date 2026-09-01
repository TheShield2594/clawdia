'use strict';

/**
 * Items that cannot leave the account that earned them.
 *
 * Both player-to-player transfer routes — `/gift` and `/market list` — refuse
 * these, and they used to each carry their own copy of the list. Two copies of
 * a security rule is one copy too many: an item added to market.js and missed
 * in gift.js is a hole nobody would notice until it was used.
 *
 * `lifesaver` and `streak_shield` are here because both are consumed
 * automatically by a background check rather than by an explicit `/use`, so a
 * traded one cannot be distinguished from an earned one after the fact.
 */
const SOULBOUND_ITEMS = new Set(['lifesaver', 'streak_shield']);

/**
 * Case-insensitive membership test.
 *
 * The comparison has to be case-insensitive because inventory itemIds are not
 * uniformly cased: a custom guild shop item is stored under its display name
 * (`shop.js` falls back to `item.name` when no itemId is set) and relics are
 * stored under theirs. A bare `SOULBOUND_ITEMS.has(typed)` would let
 * `Lifesaver` through the check.
 */
const isSoulbound = itemId => SOULBOUND_ITEMS.has(String(itemId ?? '').toLowerCase());

module.exports = { SOULBOUND_ITEMS, isSoulbound };
