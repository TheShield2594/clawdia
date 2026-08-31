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
 * credits the first slot whose itemId matches, or appends a slot when there is
 * none.
 *
 * "First" matters. A `$map` that credits every matching slot turns one credit
 * into N on a document that still carries pre-fix duplicates — buying 5 of an
 * item you hold in two slots would hand you 10. The fold below takes the credit
 * once and copies the rest through untouched, so a duplicate is left for
 * migration 010 to merge rather than being silently inflated.
 *
 * `$mergeObjects` rather than a rebuilt `{ itemId, quantity }` literal: the slot
 * is a subdocument with its own `_id`, and rebuilding it would discard that.
 *
 * Exported on its own so callers that need to fold other updates into the same
 * atomic write can compose it into their own `$set` stage.
 */
function inventoryAddExpr(itemId, quantity) {
    return {
        $let: {
            vars: {
                folded: {
                    $reduce: {
                        input: { $ifNull: ['$inventory', []] },
                        initialValue: { slots: [], credited: false },
                        in: {
                            $cond: [
                                { $and: [
                                    { $not: ['$$value.credited'] },
                                    { $eq: ['$$this.itemId', itemId] },
                                ] },
                                {
                                    slots: { $concatArrays: ['$$value.slots', [
                                        // `$ifNull` on the quantity: a legacy slot
                                        // written without one would make `$add`
                                        // evaluate to null and wipe the count.
                                        { $mergeObjects: ['$$this', {
                                            quantity: { $add: [{ $ifNull: ['$$this.quantity', 0] }, quantity] },
                                        }] },
                                    ]] },
                                    credited: true,
                                },
                                {
                                    slots: { $concatArrays: ['$$value.slots', ['$$this']] },
                                    credited: '$$value.credited',
                                },
                            ],
                        },
                    },
                },
            },
            in: {
                $cond: [
                    '$$folded.credited',
                    '$$folded.slots',
                    { $concatArrays: ['$$folded.slots', [{ itemId, quantity }]] },
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
 *   `guard`    — further *filter* clauses ANDed onto `{ userId, guildId }`, so a
 *                condition and the credit it gates are evaluated in the same
 *                write. The exactly-once payout key in src/utils/payoutKey.js is
 *                the reason this exists: a guard checked by a separate read is
 *                not a guard at all.
 *   `upsert`   — create the user document when it does not exist yet.
 *   `new`      — return the document after the update (default true).
 *   `Model`    — override the User model (tests).
 *
 * Returns the user document, or null when no document matched and `upsert` is
 * off — which, with a `guard`, means either "no such user" or "the guard
 * rejected it", and the caller has to tell those apart.
 */
async function grantInventoryItem(userId, guildId, itemId, quantity = 1, options = {}) {
    const { extraSet = {}, guard = {}, upsert = false, new: returnNew = true, Model = DEFAULT_USER } = options;

    return Model.findOneAndUpdate(
        { userId, guildId, ...guard },
        [{ $set: { inventory: inventoryAddExpr(itemId, quantity), ...extraSet } }],
        { updatePipeline: true, new: returnNew, upsert },
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
