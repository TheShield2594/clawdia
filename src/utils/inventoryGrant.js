/**
 * Atomic inventory credits.
 *
 * `inventory` is an array with no uniqueness constraint on `itemId`, so the
 * read-then-write shape that most credit sites used —
 *
 *     if (user.inventory.some(i => i.itemId === id)) $inc 'inventory.$.quantity'
 *     else                                           $push { itemId: id, ... }
 *
 * — lets two concurrent credits both miss the slot and both push, leaving two
 * slots for the same item. Every reader does `inventory.find(i => i.itemId === X)`
 * and takes the first, so the quantity in the second slot is stranded for good.
 *
 * A single aggregation-pipeline update closes the window: the "does the slot
 * exist" test and the write happen inside one document update, so a second
 * writer either sees the slot and bumps it or creates it, never both.
 * `src/commands/economy/shop.js` proved the pattern; this is that pipeline
 * extracted so every credit site shares it.
 */

const DEFAULT_USER = require('../models/User');

/**
 * Pipeline `$set` expression that adds `quantity` of `itemId` to `$inventory`:
 * bumps the matching slot when one exists, appends a slot when it does not.
 *
 * Exported on its own so callers that need to fold other updates into the same
 * atomic write can compose it into their own `$set` stage.
 */
function inventoryAddExpr(itemId, quantity) {
    return {
        $cond: {
            if: { $in: [itemId, { $ifNull: ['$inventory.itemId', []] }] },
            then: {
                $map: {
                    input: '$inventory',
                    as: 'slot',
                    in: {
                        $cond: [
                            { $eq: ['$$slot.itemId', itemId] },
                            { itemId: '$$slot.itemId', quantity: { $add: ['$$slot.quantity', quantity] } },
                            '$$slot',
                        ],
                    },
                },
            },
            else: {
                $concatArrays: [
                    { $ifNull: ['$inventory', []] },
                    [{ itemId, quantity }],
                ],
            },
        },
    };
}

/**
 * Credits `quantity` of `itemId` to one user's inventory in a single atomic update.
 *
 * Options:
 *   `extraSet` — further pipeline `$set` fields written in the same update, so a
 *                credit and the flag that records it commit together. These are
 *                aggregation expressions, not update operators: use
 *                `{ $setUnion: [{ $ifNull: ['$path', []] }, [value]] }` where you
 *                would otherwise reach for `$addToSet`.
 *   `upsert`   — create the user document when it does not exist yet.
 *   `new`      — return the document after the update (default true).
 *   `Model`    — override the User model (tests).
 *
 * Returns the user document, or null when no document matched and `upsert` is off.
 */
async function grantInventoryItem(userId, guildId, itemId, quantity = 1, options = {}) {
    const { extraSet = {}, upsert = false, new: returnNew = true, Model = DEFAULT_USER } = options;

    return Model.findOneAndUpdate(
        { userId, guildId },
        [{ $set: { inventory: inventoryAddExpr(itemId, quantity), ...extraSet } }],
        { new: returnNew, upsert },
    );
}

/**
 * Pipeline stages that credit several items in one update.
 *
 * Each item needs its own `$set` stage rather than sharing one: the expression
 * reads `$inventory`, and stages within a single `$set` all see the pre-stage
 * document, so folding them together would make the last item win. Consecutive
 * stages see each other's output, which is exactly the accumulation wanted.
 */
function inventoryAddStages(items) {
    return items.map(({ itemId, quantity = 1 }) => ({
        $set: { inventory: inventoryAddExpr(itemId, quantity) },
    }));
}

module.exports = { grantInventoryItem, inventoryAddExpr, inventoryAddStages };
