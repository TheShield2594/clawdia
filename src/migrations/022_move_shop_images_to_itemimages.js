const mongoose = require('mongoose');
const { shopImageId, isShopImageId, SHOP_IMAGE_PREFIX } = require('../models/itemImageKeys');

/**
 * Moves guild shop item images out of the guild document and into `itemimages`.
 *
 * They were `Buffer`s on `guild.shop[].imageData` — up to 512 KB each, in an
 * array with no bound, inside the settings document every cached read pulls
 * (#888). Three costs came out of that: a guild with an illustrated shop walks
 * toward MongoDB's 16 MB document ceiling and then stops saving at all; the
 * upload route read the whole document and wrote it back with `guild.save()`,
 * so it raced every concurrent settings write; and every reader owed a
 * `-shop.imageData` projection it could forget, at megabytes a time.
 *
 * The `itemimages` collection already holds the hunt/fish/mine artwork, keyed
 * `{ guildId, itemId }` since migration 014, so the shop's images join it there
 * under `shop:<itemId>` keys — namespaced because a guild's shop item ids are
 * whatever an admin typed, and one named `hunt:wooden_rifle` would otherwise
 * land on that guild's activity image. See models/itemImageKeys.js.
 *
 * Reversible: `down()` copies the Buffers back onto the shop subdocuments and
 * removes the rows it wrote. It is still the migration to have a backup before,
 * because the data being moved is the only copy of it.
 *
 * The driver is used directly rather than the model, as in migration 018 and
 * for the same reason twice over: the Guild schema no longer declares
 * `shop.imageData` at all, so a Mongoose read would drop the very field this
 * has to move, and a Mongoose write would re-run every validator on documents
 * this has no business validating.
 */

/** Batched so a guild with a fully illustrated shop is not held in memory beside 500 others. */
const BATCH = 25;

/**
 * The size of a stored image, whichever shape the driver hands it back in.
 *
 * Reading through `mongoose.connection.db` is the raw driver, and a BSON binary
 * comes back as a `Binary` — whose `length` is a method — unless the connection
 * was opened with `promoteBuffers`, in which case it is a `Buffer`, whose
 * `length` is a number. Both are written back unchanged; only the emptiness
 * check has to know the difference, and reading `.length` on a `Binary` without
 * calling it yields a function, which is truthy, which would have moved every
 * empty image as though it were real.
 */
function byteLength(value) {
    if (!value) return 0;
    return typeof value.length === 'function' ? value.length() : (value.length ?? 0);
}

const guilds = () => mongoose.connection.db.collection('guilds');
const images = () => mongoose.connection.db.collection('itemimages');

/** Guilds still holding at least one inline shop image. */
const WITH_INLINE_IMAGES = { 'shop.imageData': { $exists: true, $ne: null } };

module.exports = {
    name: '022_move_shop_images_to_itemimages',

    async up() {
        // Upserts land on `{ guildId, itemId }`, which migration 014 made
        // unique. A database that somehow lacks that index would silently
        // accept two rows for one item and serve whichever came first.
        const built = (await images().indexes()).find(i => i.name === 'idx_itemimage_guild_item');
        if (!built?.unique) {
            throw new Error(
                'itemimages { guildId, itemId } unique index is missing — migration 014 should have ' +
                'built it, and without it the moved shop images cannot be keyed. Refusing to move them.',
            );
        }

        let moved = 0;
        let guildsTouched = 0;

        const cursor = guilds().find(WITH_INLINE_IMAGES, {
            projection: { guildId: 1, 'shop.itemId': 1, 'shop.imageData': 1, 'shop.imageType': 1 },
        });

        let batch = [];
        const flush = async () => {
            if (batch.length) await images().bulkWrite(batch, { ordered: false });
            batch = [];
        };

        for await (const guild of cursor) {
            // One write per item id, not per array element. Nothing stops a
            // shop array holding two items with the same `itemId`, and two
            // upserts to one key inside a single unordered bulkWrite race each
            // other into a duplicate-key error. The later element wins, which is
            // also which one the image route served: it took the first match on
            // the id, and a second element with the same id was unreachable.
            const byId = new Map();
            for (const item of guild.shop ?? []) {
                // An item with no id was never servable: the image route keys on
                // `itemId`, so no URL could have reached it.
                if (!item?.itemId || !byteLength(item.imageData)) continue;
                byId.set(item.itemId, item);
            }
            if (!byId.size) continue;
            guildsTouched++;

            for (const [itemId, item] of byId) {
                batch.push({
                    updateOne: {
                        filter: { guildId: guild.guildId, itemId: shopImageId(itemId) },
                        // `$set` and not `$setOnInsert`: a re-run must land the
                        // guild document's copy, which is the one being removed
                        // below and therefore the one that has to win.
                        update: {
                            $set: {
                                imageData: item.imageData,
                                imageType: item.imageType || 'image/png',
                                updatedAt: new Date(),
                            },
                        },
                        upsert: true,
                    },
                });
                moved++;
            }
            if (batch.length >= BATCH) await flush();
        }
        await flush();

        // Only after every image is written. Unsetting first and failing part
        // way through would lose the ones not yet copied, and there is no other
        // copy of them.
        const cleared = await guilds().updateMany(
            { 'shop.0': { $exists: true } },
            { $unset: { 'shop.$[].imageData': '', 'shop.$[].imageType': '' } },
        );

        console.log(
            `[MIGRATIONS] 022: moved ${moved} shop image(s) from ${guildsTouched} guild(s) into ` +
            `itemimages; cleared the inline fields on ${cleared.modifiedCount} guild document(s).`,
        );
    },

    /**
     * Puts the images back on the shop subdocuments and drops the rows.
     *
     * A rollback to the previous release is a rollback to code that reads
     * `guild.shop[].imageData` and knows nothing about `shop:` keys, so leaving
     * the rows behind would be a rollback in which every shop image disappeared.
     * Rows for items the shop no longer carries are dropped rather than restored
     * — there is no subdocument to put them on.
     */
    async down() {
        const cursor = images().find({ itemId: { $regex: `^${SHOP_IMAGE_PREFIX}` } });

        let restored = 0;
        for await (const row of cursor) {
            if (!isShopImageId(row.itemId)) continue;
            const itemId = row.itemId.slice(SHOP_IMAGE_PREFIX.length);
            const result = await guilds().updateOne(
                { guildId: row.guildId, 'shop.itemId': itemId },
                {
                    $set: {
                        'shop.$.imageData': row.imageData,
                        'shop.$.imageType': row.imageType || 'image/png',
                    },
                },
            );
            if (result.matchedCount === 1) restored++;
        }

        const removed = await images().deleteMany({ itemId: { $regex: `^${SHOP_IMAGE_PREFIX}` } });

        console.log(
            `[MIGRATIONS] 022 rollback: restored ${restored} shop image(s) inline and removed ` +
            `${removed.deletedCount} row(s) from itemimages.`,
        );
    },
};
