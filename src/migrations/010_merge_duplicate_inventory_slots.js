const mongoose = require('mongoose');

/**
 * Merges duplicate `inventory` slots that share an `itemId`.
 *
 * The credit sites used to test for an existing slot and then `$push` when they
 * did not find one, in two separate round trips. Two concurrent credits could
 * both miss and both push, leaving a document with two slots for one item.
 * Every reader does `inventory.find(i => i.itemId === X)` and takes the first
 * match, so whatever landed in the second slot was invisible and unspendable.
 *
 * The credit path is atomic now (src/utils/inventoryGrant.js), so no new
 * duplicates appear — but the ones already written stay stranded until they are
 * folded together, which is what this does: one slot per itemId, carrying the
 * summed quantity, in the order the slots first appeared.
 *
 * Documents with no duplicates are left untouched.
 */
module.exports = {
    name: '010_merge_duplicate_inventory_slots',

    async up() {
        const users = mongoose.connection.db.collection('users');

        // Only documents that actually have a repeated itemId are rewritten —
        // comparing the slot count against the distinct-itemId count finds them
        // without pulling every user document into the application.
        const cursor = users.find(
            {
                $expr: {
                    $ne: [
                        { $size: { $ifNull: ['$inventory', []] } },
                        { $size: { $setUnion: [{ $ifNull: ['$inventory.itemId', []] }, []] } },
                    ],
                },
            },
            { projection: { inventory: 1 } },
        );

        let merged = 0;
        const ops = [];

        const flush = async () => {
            if (!ops.length) return;
            await users.bulkWrite(ops, { ordered: false });
            ops.length = 0;
        };

        for await (const doc of cursor) {
            const totals = new Map();
            for (const slot of doc.inventory ?? []) {
                const id = slot?.itemId;
                if (id === undefined || id === null) continue;
                totals.set(id, (totals.get(id) ?? 0) + (slot.quantity ?? 0));
            }

            const inventory = [...totals].map(([itemId, quantity]) => ({ itemId, quantity }));
            ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { inventory } } } });
            merged++;

            if (ops.length >= 500) await flush();
        }
        await flush();

        if (merged > 0) {
            console.log(`[MIGRATIONS] 010: merged duplicate inventory slots on ${merged} user document(s).`);
        }
    },
};
