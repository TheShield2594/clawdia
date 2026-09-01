'use strict';

/**
 * One place that turns an inventory `itemId` into something worth showing a
 * player.
 *
 * An inventory entry is only ever an id, and the id is not a label: shop items
 * are stored snake_cased (`coin_booster_2x`), forged items as an opaque
 * `ai_<hex>`, relics under their prose name. `/inventory` already resolved all
 * three inline; anything else that named an item — `/gift` most visibly —
 * printed the raw id and left the player to work out that `pet_slot_expansion`
 * was the Pet Slot Expansion they bought.
 *
 * Nothing here touches the database: pass in the guild's shop list (which
 * `getGuildSettings` already has) and, for `ai_` ids, the AiItem document the
 * caller looked up. That keeps this usable inside an autocomplete handler,
 * where Discord gives you three seconds and a per-item query is not affordable.
 */

const { DEFAULT_SHOP_ITEMS, getItemLore, getItemRarity } = require('../data/defaultShopItems');
const { getRelicMeta } = require('../data/exploreData');

// Matches /shop's rarity swatches so an item wears the same colour wherever it
// is named.
const RARITY_EMOJIS = {
    Common:    '⚪',
    Uncommon:  '🟢',
    Rare:      '🔵',
    Epic:      '🟣',
    Mythic:    '🟠',
    // The forge mints a sixth tier above Mythic that the shop has no equivalent
    // for, so a forged Legendary would otherwise render with no swatch at all.
    Legendary: '⭐',
};

const RARITY_HEX = {
    Common:    '#95a5a6',
    Uncommon:  '#2ecc71',
    Rare:      '#3498db',
    Epic:      '#9b59b6',
    Mythic:    '#e67e22',
    Legendary: '#ffd700',
};

/**
 * What a forged item is worth.
 *
 * There is no price on an AiItem — it was forged, not sold — so its worth is
 * what it cost to forge, which is the one figure the economy has already
 * committed to for that rarity. Kept in step with RARITY_CONFIG in
 * commands/economy/forge.js.
 */
const FORGE_COST_BY_RARITY = {
    Common:    500,
    Uncommon:  1_000,
    Rare:      2_500,
    Epic:      5_000,
    Mythic:    10_000,
    Legendary: 25_000,
};

// Relic rarities are lowercase and only span three tiers; map them onto the
// shop's five so one embed doesn't have to know which vocabulary it was handed.
const RELIC_RARITY_LABELS = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Mythic' };

/** The leading emoji of a shop description (`'🔒 Protects…'` → `'🔒'`), if any. */
function leadingEmoji(str) {
    if (!str) return '';
    const m = String(str).match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    return m ? m[0] : '';
}

/**
 * Describe one inventory item.
 *
 * @param {string} itemId    the id as stored in `user.inventory`
 * @param {object} [options]
 * @param {Array}  [options.shopItems] the guild's `shop` array, for custom items
 * @param {object} [options.aiItem]    the AiItem document, for an `ai_` id
 * @returns {{ itemId, name, emoji, rarity, rarityEmoji, color, lore, value, kind }}
 *          `name` always falls back to the id, so this never renders empty.
 *          `value` is the item's worth in coins — the guild's shop price, the
 *          relic's payout, or what the rarity cost to forge — and is 0 for an
 *          item nothing in the game puts a number on.
 */
function describeItem(itemId, { shopItems = [], aiItem = null } = {}) {
    const id = String(itemId ?? '');

    const relic = getRelicMeta(id);
    if (relic) {
        const rarity = RELIC_RARITY_LABELS[relic.rarity] ?? 'Rare';
        return {
            itemId: id,
            name: id,
            emoji: relic.emoji ?? '🏺',
            rarity,
            rarityEmoji: RARITY_EMOJIS[rarity] ?? '',
            color: RARITY_HEX[rarity],
            lore: relic.lore ?? '',
            value: relic.value ?? 0,
            kind: 'relic',
        };
    }

    if (id.startsWith('ai_')) {
        const rarity = aiItem?.rarity ?? null;
        return {
            itemId: id,
            // A forged item whose AiItem document is missing renders as the id
            // rather than as nothing — the same fallback /inventory uses.
            name: aiItem?.name ?? id,
            emoji: aiItem?.emoji ?? '✨',
            rarity,
            rarityEmoji: rarity ? (RARITY_EMOJIS[rarity] ?? '✨') : '',
            color: (rarity && RARITY_HEX[rarity]) ?? '#f1c40f',
            lore: aiItem?.lore ?? '',
            value: FORGE_COST_BY_RARITY[rarity] ?? FORGE_COST_BY_RARITY.Legendary,
            kind: 'forged',
        };
    }

    // Custom guild items are matched on either field: shop.js stores an item
    // under `itemId || name`, so an admin-made item can be sitting in the
    // inventory under its display name.
    //
    // The built-in catalogue is the fallback rather than the first lookup: a
    // guild's own row for a default item carries that guild's price and any
    // renaming an admin has done, and should win. It is only consulted when the
    // caller had no shop list to give (a stale cache, or a code path that never
    // loads guild settings), so a default item still reads as "Pet Food" there
    // instead of `pet_food`.
    const lower = id.toLowerCase();
    const shopItem = shopItems.find(s =>
        (s.itemId ?? '').toLowerCase() === lower || (s.name ?? '').toLowerCase() === lower)
        ?? DEFAULT_SHOP_ITEMS.find(s => s.itemId.toLowerCase() === lower || s.name.toLowerCase() === lower);

    const rarity = shopItem
        ? getItemRarity(shopItem.itemId ?? id, shopItem.price ?? 0)
        : getItemRarity(id, 0);

    return {
        itemId: id,
        name: shopItem?.name ?? id,
        emoji: leadingEmoji(shopItem?.description) || '🎁',
        rarity,
        rarityEmoji: RARITY_EMOJIS[rarity] ?? '',
        color: RARITY_HEX[rarity],
        lore: shopItem?.lore ?? getItemLore(lower) ?? '',
        // The guild's own price when it has one, so a server that discounted an
        // item is judged against the price its players actually pay.
        value: Math.max(0, Number(shopItem?.price) || 0),
        kind: 'shop',
    };
}

module.exports = { describeItem, RARITY_EMOJIS, RARITY_HEX, FORGE_COST_BY_RARITY };
