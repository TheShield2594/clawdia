'use strict';

// Inventory credits used to test for an existing slot and then `$push` when they
// did not find one, across two round trips. Two credits landing together could
// both miss and both push, leaving two slots for one itemId — and since every
// reader does `inventory.find(i => i.itemId === X)` and takes the first match,
// whatever went into the second slot was invisible and unspendable.
//
// The replacement is a single aggregation-pipeline update. These tests run that
// pipeline against plain objects (tests/helpers/pipelineUpdate.js) so the
// expression's actual semantics are checked, not just the shape of the call.

const { grantInventoryItem, inventoryAddExpr, inventoryAddStages } = require('../src/utils/inventoryGrant');
const { applyPipelineUpdate } = require('./helpers/pipelineUpdate');

/** Applies one credit to a document the way Mongo would. */
function credit(doc, itemId, quantity = 1) {
    return applyPipelineUpdate(doc, [{ $set: { inventory: inventoryAddExpr(itemId, quantity) } }]);
}

const slots = doc => doc.inventory.map(s => `${s.itemId}:${s.quantity}`);

describe('inventoryAddExpr', () => {
    test('appends a slot when the item is not held', () => {
        const doc = { inventory: [] };
        credit(doc, 'lucky_charm');
        expect(slots(doc)).toEqual(['lucky_charm:1']);
    });

    test('bumps the existing slot instead of appending a second one', () => {
        const doc = { inventory: [{ itemId: 'lucky_charm', quantity: 2 }] };
        credit(doc, 'lucky_charm', 3);
        expect(slots(doc)).toEqual(['lucky_charm:5']);
    });

    test('leaves other items alone', () => {
        const doc = { inventory: [{ itemId: 'a', quantity: 1 }, { itemId: 'b', quantity: 4 }] };
        credit(doc, 'b', 2);
        expect(slots(doc)).toEqual(['a:1', 'b:6']);
    });

    test('handles a document with no inventory field at all', () => {
        const doc = {};
        credit(doc, 'pet_food', 7);
        expect(slots(doc)).toEqual(['pet_food:7']);
    });

    test('repeated credits never produce a duplicate slot — the original bug', () => {
        const doc = { inventory: [] };
        for (let i = 0; i < 25; i++) credit(doc, 'crate');
        expect(slots(doc)).toEqual(['crate:25']);
        expect(doc.inventory.filter(s => s.itemId === 'crate')).toHaveLength(1);
    });

    test('an existing duplicate is credited once, not once per slot', () => {
        // Documents written before the fix can still hold two slots; migration 010
        // folds those together. Until it runs a credit must not add a third slot,
        // and — the sharper trap — must not pay into both: crediting every match
        // turns 5 units into 10 on a document that already lost track of itself.
        const doc = { inventory: [{ itemId: 'x', quantity: 1 }, { itemId: 'x', quantity: 9 }] };
        credit(doc, 'x', 5);
        expect(slots(doc)).toEqual(['x:6', 'x:9']);
    });

    test('a legacy slot with no quantity is credited, not wiped', () => {
        // `$add` propagates null in Mongo, so adding to a missing quantity would
        // set the slot to null and lose the item entirely.
        const doc = { inventory: [{ itemId: 'old' }] };
        credit(doc, 'old', 3);
        expect(slots(doc)).toEqual(['old:3']);
    });

    test('keeps the slot subdocument rather than rebuilding it', () => {
        // Inventory entries are subdocuments with their own `_id`; a credit that
        // rebuilt `{ itemId, quantity }` would silently drop it.
        const doc = { inventory: [{ _id: 'slot-1', itemId: 'y', quantity: 2 }] };
        credit(doc, 'y', 1);
        expect(doc.inventory[0]).toEqual({ _id: 'slot-1', itemId: 'y', quantity: 3 });
    });
});

describe('inventoryAddStages', () => {
    test('credits several items in one update', () => {
        const doc = { inventory: [{ itemId: 'lifesaver', quantity: 1 }] };
        applyPipelineUpdate(doc, inventoryAddStages([
            { itemId: 'lifesaver', quantity: 1 },
            { itemId: 'lucky_charm', quantity: 1 },
        ]));
        expect(slots(doc)).toEqual(['lifesaver:2', 'lucky_charm:1']);
    });

    test('accumulates when the same item appears twice in one batch', () => {
        // Each item gets its own stage precisely so the second sees the first's
        // output; folding them into one stage would let the last write win.
        const doc = { inventory: [] };
        applyPipelineUpdate(doc, inventoryAddStages([
            { itemId: 'ore', quantity: 2 },
            { itemId: 'ore', quantity: 3 },
        ]));
        expect(slots(doc)).toEqual(['ore:5']);
    });

    test('defaults a missing quantity to one', () => {
        const doc = { inventory: [] };
        applyPipelineUpdate(doc, inventoryAddStages([{ itemId: 'token' }]));
        expect(slots(doc)).toEqual(['token:1']);
    });
});

describe('grantInventoryItem', () => {
    const fakeModel = () => {
        const calls = [];
        return {
            calls,
            findOneAndUpdate: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
        };
    };

    test('issues exactly one update — no read, no second write', async () => {
        const Model = fakeModel();
        await grantInventoryItem('u1', 'g1', 'rope', 2, { Model });
        expect(Model.calls).toHaveLength(1);
    });

    test('targets the user and passes a pipeline, not an update document', async () => {
        const Model = fakeModel();
        await grantInventoryItem('u1', 'g1', 'rope', 2, { Model });
        const [filter, update, options] = Model.calls[0];
        expect(filter).toEqual({ userId: 'u1', guildId: 'g1' });
        expect(Array.isArray(update)).toBe(true);
        expect(options).toMatchObject({ new: true, upsert: false });
    });

    test('folds extraSet fields into the same atomic update', async () => {
        const Model = fakeModel();
        await grantInventoryItem('u1', 'g1', 'rope', 1, { Model, extraSet: { 'streak.revivalToken': true } });
        const [, update] = Model.calls[0];
        // Bracketed, not toHaveProperty: the key is the literal dotted path
        // Mongo expects, which toHaveProperty would read as a nesting path.
        expect(update[0].$set['streak.revivalToken']).toBe(true);
        expect(update[0].$set.inventory).toBeDefined();
    });

    test('passes upsert through for the credit sites that create the user', async () => {
        const Model = fakeModel();
        await grantInventoryItem('u1', 'g1', 'rope', 1, { Model, upsert: true });
        expect(Model.calls[0][2]).toMatchObject({ upsert: true });
    });

    test('defaults to crediting one unit', async () => {
        const Model = fakeModel();
        await grantInventoryItem('u1', 'g1', 'rope', undefined, { Model });
        const doc = { inventory: [] };
        applyPipelineUpdate(doc, Model.calls[0][1]);
        expect(slots(doc)).toEqual(['rope:1']);
    });
});
