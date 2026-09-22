const mongoose = require('mongoose');
const { defaultItemIdByName } = require('../data/defaultShopItems');

/**
 * Gives back the canonical `itemId` to default shop items that were seeded
 * without one.
 *
 * A guild seeded before the shop grew an `itemId` field carries its default
 * items with `itemId: null` (the schema default). Everything that keys off that
 * id then quietly falls back: the /shop view looks the baked catalogue icon up
 * by id and finds nothing, so it draws the emoji glyph instead of the artwork
 * (#shop, the white-icon report); `getItemRarity` drops to price bucketing, so
 * an item whose tier does not match its price lands on the wrong page; and a
 * purchase is stocked under the display name rather than the id. The recently
 * backfilled items (endgame cosmetics, streak_freeze, tier_skip_token,
 * revive_scroll) carry correct ids and never had the problem — which is why
 * only the older items looked "unmapped".
 *
 * The one field those old rows still have is the display name, and it is the
 * same name the catalogue seeds, so `defaultItemIdByName` recovers the id from
 * it. Only rows with no id are touched — a custom item an admin named after a
 * default keeps whatever id it already had, and an item whose name is not in the
 * catalogue is left as it was (its art comes from a guild upload, not the
 * catalogue).
 *
 * Inventory is not rewritten: a booster bought before this ran is stored under
 * its name, and `/use` already resolves those through the legacy space-separated
 * aliases in services/effectsService.js, so both the old name and the new id
 * work. Future purchases stock under the id.
 *
 * The raw driver, as in migrations 011 and 022: `itemId` is a live schema field,
 * but a Mongoose `save()` would revalidate every unrelated field on a guild
 * document this has no business validating, and index positions are stable
 * because migrations run at boot before the bot logs in and before the dashboard
 * opens its port, so nothing edits a shop array underneath the sweep.
 */
module.exports = {
    name: '026_backfill_shop_item_ids',

    // The ids are filled in place. Afterwards a `shop.itemId` of `knife` cannot
    // be told apart from one that was always there, so there is no faithful
    // inverse — the pre-migration dump is the way back.
    irreversible: true,

    async up({ timeoutMs } = {}) {
        const guilds = mongoose.connection.db.collection('guilds');

        // Only guilds with at least one shop item missing its id. Matches the
        // three shapes a missing id takes: an explicit null, an empty string, or
        // the field never written at all.
        const cursor = guilds.find(
            {
                shop: {
                    $elemMatch: {
                        $or: [{ itemId: null }, { itemId: '' }, { itemId: { $exists: false } }],
                    },
                },
            },
            {
                projection: { _id: 1, 'shop.itemId': 1, 'shop.name': 1 },
                // Bound the scan to the migration's own budget rather than let it
                // run unbanked against the server, as the runner documents.
                ...(timeoutMs ? { maxTimeMS: timeoutMs } : {}),
            },
        );

        let itemsFixed = 0;
        let guildsTouched = 0;

        for await (const guild of cursor) {
            // By array index, so each element gets its own recovered id in one
            // targeted $set — the elements sharing a null id cannot share an
            // arrayFilter that would otherwise stamp them all with one value.
            const set = {};
            (guild.shop ?? []).forEach((item, index) => {
                if (item?.itemId) return;                 // already has an id
                const id = defaultItemIdByName(item?.name);
                if (!id) return;                          // custom item — leave it be
                set[`shop.${index}.itemId`] = id;
            });

            if (!Object.keys(set).length) continue;

            const result = await guilds.updateOne({ _id: guild._id }, { $set: set });
            if (result.modifiedCount) {
                guildsTouched++;
                itemsFixed += Object.keys(set).length;
            }
        }

        if (itemsFixed > 0) {
            console.log(
                `[MIGRATIONS] 026: backfilled ${itemsFixed} shop item id(s) across ${guildsTouched} guild(s).`,
            );
        }
    },
};
