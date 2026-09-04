'use strict';

/**
 * #888. Migration 022, driven against a fake driver.
 *
 * Shop item images were `Buffer`s on `guild.shop[].imageData` — up to 512 KB
 * each, in an array with no bound, inside the settings document every cached
 * read pulls. This is the migration that moves them into `itemimages`, where
 * the hunt/fish/mine artwork already lives, and it is the only copy of that
 * data while it runs.
 *
 * So the properties worth holding are about the order and the keying rather
 * than about a count:
 *
 *   1. Nothing is cleared until everything is written. Unsetting first and
 *      failing part way would lose the images not yet copied, and there is no
 *      other copy of them.
 *   2. Shop images land under `shop:<itemId>`, not the bare id. A guild's shop
 *      item ids are whatever an admin typed, so one named `hunt:wooden_rifle`
 *      would otherwise overwrite that guild's activity icon — a small, local
 *      version of the cross-guild bug #561 closed.
 *   3. It can be rolled back. A rollback to the previous release is a rollback
 *      to code that reads `guild.shop[].imageData` and knows nothing about
 *      `shop:` keys, so leaving the rows behind is a rollback in which every
 *      shop image disappears.
 *
 * The real mongoose with only `connection.db` swapped, matching
 * tests/migrationClampNegativeBalances.test.js: mocking the module outright
 * would take `Schema` and `model` with it.
 */

const mongoose = require('mongoose');
const migration = require('../src/migrations/022_move_shop_images_to_itemimages');

const bytes = text => Buffer.from(text);

/**
 * Just enough of the driver for this migration: the two collections, with real
 * effects rather than recorded calls, so the assertions can be about where the
 * images ended up.
 */
function fakeDb({ guilds = [], images = [], unique = true } = {}) {
    const order = [];

    // The clear is addressed by _id, which a real cursor always carries.
    guilds.forEach((guild, i) => { guild._id = guild._id ?? `guild-${i}`; });

    const hasInlineImage = g => (g.shop ?? []).some(i => i?.imageData != null);

    const cursor = docs => ({
        async *[Symbol.asyncIterator]() { for (const doc of docs) yield doc; },
    });

    const guildsCollection = {
        find: filter => {
            // The one filter the migration uses; anything else is a change this
            // fake has not been told about.
            expect(filter).toEqual({ 'shop.imageData': { $exists: true, $ne: null } });
            return cursor(guilds.filter(hasInlineImage));
        },
        updateOne: async (filter, update) => {
            // `up` clears the entries it moved, addressed by _id and an array
            // filter; `down` restores one entry, addressed by the positional $.
            if (update.$unset) {
                order.push('clear');
                const guild = guilds.find(g => g._id === filter._id);
                let modified = 0;
                for (const path of Object.keys(update.$unset)) {
                    // `shop.<index>.<field>` — addressed by position, so a
                    // duplicate id cannot drag its sibling's image out with it.
                    const [, index, field] = path.split('.');
                    const item = guild?.shop?.[Number(index)];
                    if (!item || !(field in item)) continue;
                    delete item[field];
                    modified = 1;
                }
                return { modifiedCount: modified };
            }
            const guild = guilds.find(g => g.guildId === filter.guildId);
            const item = guild?.shop?.find(i => i.itemId === filter['shop.itemId']);
            if (!item) return { matchedCount: 0 };
            item.imageData = update.$set['shop.$.imageData'];
            item.imageType = update.$set['shop.$.imageType'];
            return { matchedCount: 1 };
        },
    };

    const imagesCollection = {
        indexes: async () => [{ name: 'idx_itemimage_guild_item', unique }],
        bulkWrite: async ops => {
            order.push('write');
            for (const { updateOne } of ops) {
                const { guildId, itemId } = updateOne.filter;
                const existing = images.find(d => d.guildId === guildId && d.itemId === itemId);
                if (existing) Object.assign(existing, updateOne.update.$set);
                else images.push({ guildId, itemId, ...updateOne.update.$set });
            }
        },
        find: filter => cursor(images.filter(d => new RegExp(filter.itemId.$regex).test(d.itemId))),
        deleteMany: async filter => {
            const pattern = new RegExp(filter.itemId.$regex);
            const kept = images.filter(d => !pattern.test(d.itemId));
            const deletedCount = images.length - kept.length;
            images.length = 0;
            images.push(...kept);
            return { deletedCount };
        },
    };

    mongoose.connection.db = {
        collection: name => (name === 'guilds' ? guildsCollection : imagesCollection),
    };
    return { guilds, images, order };
}

let logged;
let realDb;

beforeEach(() => {
    realDb = mongoose.connection.db;
    logged = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    mongoose.connection.db = realDb;
    logged.mockRestore();
});

describe('up', () => {
    it('moves each image into itemimages under a namespaced key', async () => {
        const db = fakeDb({
            guilds: [{
                guildId: 'g1',
                shop: [
                    { itemId: 'padlock', imageData: bytes('lock-art'), imageType: 'image/png' },
                    { itemId: 'shield', imageData: bytes('shield-art'), imageType: 'image/gif' },
                ],
            }],
        });

        await migration.up();

        expect(db.images).toEqual([
            { guildId: 'g1', itemId: 'shop:padlock', imageData: bytes('lock-art'), imageType: 'image/png', updatedAt: expect.any(Date) },
            { guildId: 'g1', itemId: 'shop:shield', imageData: bytes('shield-art'), imageType: 'image/gif', updatedAt: expect.any(Date) },
        ]);
    });

    it('does not collide with the guild activity image of the same name', async () => {
        // A shop item an admin called `hunt:wooden_rifle`. Unnamespaced, the
        // upsert would land on that guild's activity row and replace its icon.
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: 'hunt:wooden_rifle', imageData: bytes('shop-art') }] }],
            images: [{ guildId: 'g1', itemId: 'hunt:wooden_rifle', imageData: bytes('activity-art') }],
        });

        await migration.up();

        expect(db.images).toHaveLength(2);
        expect(db.images.find(d => d.itemId === 'hunt:wooden_rifle').imageData).toEqual(bytes('activity-art'));
        expect(db.images.find(d => d.itemId === 'shop:hunt:wooden_rifle').imageData).toEqual(bytes('shop-art'));
    });

    it('clears the inline fields only after every image is written', async () => {
        // The other order loses whatever had not been copied when it failed,
        // and there is no second copy of it.
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: 'padlock', imageData: bytes('art'), imageType: 'image/png' }] }],
        });

        await migration.up();

        expect(db.order).toEqual(['write', 'clear']);
        expect(db.guilds[0].shop[0]).toEqual({ itemId: 'padlock' });
    });

    it('is idempotent — a second run overwrites rather than duplicating', async () => {
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: 'padlock', imageData: bytes('art') }] }],
        });

        await migration.up();
        await migration.up();

        expect(db.images).toHaveLength(1);
    });

    it('writes one row per item id when a shop holds the same id twice', async () => {
        // Nothing stops a shop array holding two items with one `itemId`, and
        // two upserts to one key in an unordered bulkWrite race into a
        // duplicate-key error. The first wins, because that is the one the
        // routes served — both resolved an id with `shop.find(...)`, so the
        // second was already unreachable. Moving the second would change which
        // artwork the guild sees, on a migration whose job is to move it
        // unchanged.
        const db = fakeDb({
            guilds: [{
                guildId: 'g1',
                shop: [
                    { itemId: 'padlock', imageData: bytes('first') },
                    { itemId: 'padlock', imageData: bytes('second') },
                ],
            }],
        });

        await migration.up();

        expect(db.images).toHaveLength(1);
        expect(db.images[0].imageData).toEqual(bytes('first'));
        // And the one that was not moved keeps its inline image: there is no key
        // to store a second image for one id under, so clearing it would be a
        // delete with nothing written down.
        expect(db.guilds[0].shop[0]).toEqual({ itemId: 'padlock' });
        expect(db.guilds[0].shop[1]).toEqual({ itemId: 'padlock', imageData: bytes('second') });
    });

    it('takes the entry the routes resolved, even when it is the empty one', () => {
        // `shop.find(...)` returns the first entry with the id whatever its
        // image, so an empty first duplicate is a guild that saw no shop image
        // for it. Moving the second one's artwork would put a picture on screen
        // that was not there before, which is not a migration's job.
        const db = fakeDb({
            guilds: [{
                guildId: 'g1',
                shop: [
                    { itemId: 'padlock', imageData: null },
                    { itemId: 'padlock', imageData: bytes('hidden') },
                ],
            }],
        });

        return migration.up().then(() => {
            expect(db.images).toEqual([]);
            expect(db.guilds[0].shop[1].imageData).toEqual(bytes('hidden'));
        });
    });

    it('skips an item with no id, which was never servable', async () => {
        // The image route keys on `itemId`; there was no URL that could reach
        // an image stored beside a null one.
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: null, imageData: bytes('orphan') }] }],
        });

        await migration.up();

        expect(db.images).toEqual([]);
    });

    it('leaves the inline image of an entry it could not move', async () => {
        // Clearing it would be a delete with nothing written down: there is no
        // key to store an image for an item with no id under, so there would be
        // nothing for `down` to put back and no copy of it anywhere.
        const db = fakeDb({
            guilds: [{
                guildId: 'g1',
                shop: [
                    { itemId: 'padlock', imageData: bytes('moved'), imageType: 'image/png' },
                    { itemId: null, imageData: bytes('unmovable'), imageType: 'image/gif' },
                ],
            }],
        });

        await migration.up();

        expect(db.guilds[0].shop[0]).toEqual({ itemId: 'padlock' });
        expect(db.guilds[0].shop[1]).toEqual({
            itemId: null, imageData: bytes('unmovable'), imageType: 'image/gif',
        });
    });

    it('rewrites only the guilds it moved something out of', async () => {
        // `$[]` over every shop in the collection rewrote every guild document
        // that has one, including the ones with no image to move.
        const db = fakeDb({
            guilds: [
                { guildId: 'g1', shop: [{ itemId: 'padlock', imageData: bytes('art') }] },
                { guildId: 'g2', shop: [{ itemId: 'shield', price: 10 }] },
            ],
        });

        await migration.up();

        expect(db.guilds[1].shop[0]).toEqual({ itemId: 'shield', price: 10 });
        expect(db.order.filter(op => op === 'clear')).toHaveLength(1);
    });

    it('refuses to run without the unique index the keys depend on', async () => {
        // Migration 014 builds it. Without it the upserts silently accept two
        // rows for one item and the route serves whichever came first.
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: 'padlock', imageData: bytes('art') }] }],
            unique: false,
        });

        await expect(migration.up()).rejects.toThrow(/unique index is missing/);
        // And nothing was moved or cleared on the way to refusing.
        expect(db.images).toEqual([]);
        expect(db.guilds[0].shop[0].imageData).toEqual(bytes('art'));
    });
});

describe('down', () => {
    it('puts the images back inline and removes the rows it wrote', async () => {
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: 'padlock', imageData: bytes('art'), imageType: 'image/gif' }] }],
        });

        await migration.up();
        await migration.down();

        expect(db.guilds[0].shop[0]).toEqual({
            itemId: 'padlock', imageData: bytes('art'), imageType: 'image/gif',
        });
        expect(db.images).toEqual([]);
    });

    it('leaves the activity images where they are', async () => {
        // They were never this migration's to move, and a rollback that took
        // them out would undo #561 as a side effect.
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [{ itemId: 'padlock', imageData: bytes('art') }] }],
            images: [{ guildId: 'g1', itemId: 'hunt:wooden_rifle', imageData: bytes('activity-art') }],
        });

        await migration.up();
        await migration.down();

        expect(db.images).toEqual([
            { guildId: 'g1', itemId: 'hunt:wooden_rifle', imageData: bytes('activity-art') },
        ]);
    });

    it('drops a row whose shop item is gone rather than failing on it', async () => {
        // An admin who deleted the item after the migration ran leaves a row
        // with no subdocument to restore it to.
        const db = fakeDb({
            guilds: [{ guildId: 'g1', shop: [] }],
            images: [{ guildId: 'g1', itemId: 'shop:padlock', imageData: bytes('orphan') }],
        });

        await migration.down();

        expect(db.images).toEqual([]);
    });
});
