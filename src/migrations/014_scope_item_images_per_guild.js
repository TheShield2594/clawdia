const mongoose = require('mongoose');

/**
 * Re-keys the itemimages collection from `{ itemId }` to `{ guildId, itemId }`.
 *
 * Activity item images were stored globally and written by any admin of any
 * guild the bot is in, so one guild's admin could overwrite or delete the icons
 * every other guild sees (#561). The fix is per-guild documents, and the old
 * unique index on `itemId` is what makes those impossible: with it in place the
 * second guild to upload the same item gets a duplicate-key error instead of
 * its own row.
 *
 * Dropping an index is not something Mongoose does on its own — declaring the
 * new compound index in the model leaves the old one exactly where it is — so
 * it happens here, before the routes that rely on the new key are serving.
 *
 * Existing documents are left with `guildId: null` rather than being assigned
 * to a guild: there is no record of who uploaded them and no guild has a better
 * claim than any other. They stay readable as a shared fallback (see
 * ItemImage.js and utils/itemImageHelper.js) and nothing writes them again.
 */
module.exports = {
    name: '014_scope_item_images_per_guild',

    async up() {
        const images = mongoose.connection.db.collection('itemimages');

        // Pre-#561 rows have no guildId at all. The compound unique index treats
        // a missing field and an explicit null as the same key, but the reads
        // that fall back to the shared image match on `guildId: null`, so the
        // field is written out rather than left absent.
        await images.updateMany({ guildId: { $exists: false } }, { $set: { guildId: null } });

        // The old key. Named by Mongoose's convention when it built it from
        // `unique: true` on the field; a database that never had it just skips.
        await images.dropIndex('itemId_1').catch(err => {
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });

        await images.createIndex(
            { guildId: 1, itemId: 1 },
            { name: 'idx_itemimage_guild_item', unique: true },
        );

        const built = (await images.indexes()).find(i => i.name === 'idx_itemimage_guild_item');
        if (!built?.unique) {
            throw new Error(
                'itemimages { guildId, itemId } unique index missing after createIndex — ' +
                'per-guild image writes would collide without it, so startup must not continue.',
            );
        }
    },

    /**
     * Unwinding this restores the shared collection, which is only safe if the
     * per-guild documents it now holds are removed first: two guilds' rows for
     * the same item cannot both survive a unique index on `itemId`. The rows
     * written since the migration ran are therefore dropped, and the pre-#561
     * shared images (`guildId: null`) are what remain — the exact state `up`
     * started from.
     */
    async down() {
        const images = mongoose.connection.db.collection('itemimages');

        await images.deleteMany({ guildId: { $ne: null } });

        await images.dropIndex('idx_itemimage_guild_item').catch(err => {
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
        await images.createIndex({ itemId: 1 }, { name: 'itemId_1', unique: true });
    },
};
