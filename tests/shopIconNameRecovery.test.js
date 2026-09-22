'use strict';

/**
 * Old default shop items still render their catalogue art in /shop view.
 *
 * A guild seeded before the `itemId` field existed carries default items whose
 * stored `itemId` is null, so `getDefaultItemImage(null)` finds nothing and the
 * shop banner falls back to the emoji glyph (the white silhouette reported in
 * #shop). The recent backfill items (endgame cosmetics, streak_freeze,
 * tier_skip_token, revive_scroll) carry correct ids and render — which is why
 * only the older items looked "unmapped".
 *
 * defaultItemIdByName recovers the catalogue id from the one field those old
 * rows still have — the display name — and every catalogue name must map to an
 * id the baked set actually ships art for, or the recovery is pointless.
 */

const {
    DEFAULT_SHOP_ITEMS,
    defaultItemIdByName,
} = require('../src/data/defaultShopItems');
const { hasDefaultItemImage } = require('../src/utils/defaultItemImages');

describe('defaultItemIdByName', () => {
    test('maps a display name to its canonical itemId', () => {
        expect(defaultItemIdByName('Knife')).toBe('knife');
        expect(defaultItemIdByName('2x Coin Booster')).toBe('coin_booster_2x');
        expect(defaultItemIdByName('Invisibility Cloak')).toBe('invisibility_cloak');
    });

    test('is case-insensitive and trims surrounding whitespace', () => {
        expect(defaultItemIdByName('  sHiElD ')).toBe('shield');
    });

    test('returns null for a name that is not in the catalogue', () => {
        expect(defaultItemIdByName('Totally Custom Item')).toBeNull();
        expect(defaultItemIdByName('')).toBeNull();
        expect(defaultItemIdByName(null)).toBeNull();
        expect(defaultItemIdByName(undefined)).toBeNull();
    });

    // The whole point of the recovery: the id it hands back must be one the
    // bundled catalogue ships art for, for every default item. A name that
    // resolved to an id with no baked PNG would still render the white glyph.
    test('every catalogue name recovers an id with bundled artwork', () => {
        for (const item of DEFAULT_SHOP_ITEMS) {
            const recovered = defaultItemIdByName(item.name);
            expect(recovered).toBe(item.itemId);
            expect(hasDefaultItemImage(recovered)).toBe(true);
        }
    });
});
