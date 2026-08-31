'use strict';

// /use decrements an item with an atomic findOneAndUpdate, then had to clear the
// slot if that took the last one. Every handler did it the same way: filter the
// array in memory and save(). save() writes each modified path as a `$set`, and
// `inventory` is an array, so that wrote the whole list back from a snapshot
// taken a moment earlier — erasing anything bought, gifted or dropped into the
// bag in between. The cleanup is a targeted `$pull` now, and where the save is
// still needed for something else the array is unmarked so it stays out of it.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const USE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'economy', 'use.js'), 'utf8');

describe('the mongoose contract the cleanup relies on', () => {
    // Behavioural, against the real User schema: if a mongoose upgrade ever made
    // unmarkModified stop excluding a path, the two handlers that still save
    // would quietly go back to overwriting the whole inventory.
    const User = require('../src/models/User');

    const hydrate = () => User.hydrate({
        _id: new mongoose.Types.ObjectId(),
        userId: 'u', guildId: 'g', balance: 5_000,
        inventory: [{ itemId: 'keep', quantity: 2 }, { itemId: 'spent', quantity: 0 }],
        pets: [],
    });

    test('a bare filter-then-save rewrites the entire inventory array', () => {
        const doc = hydrate();
        doc.inventory = doc.inventory.filter(e => e.quantity > 0);
        expect(doc.$getChanges().$set).toHaveProperty('inventory');
    });

    test('unmarking the path keeps it out of the write', () => {
        const doc = hydrate();
        doc.pets.push({ petId: 'dog', hunger: 100 });
        doc.markModified('pets');
        doc.inventory = doc.inventory.filter(e => e.quantity > 0);
        doc.unmarkModified('inventory');

        const changes = JSON.stringify(doc.$getChanges());
        expect(changes).not.toContain('"inventory"');
        // The mutation the save actually exists for still goes out.
        expect(changes).toContain('pets');
        // And the in-memory list stays filtered for whatever is rendered next.
        expect(doc.inventory).toHaveLength(1);
    });

    test('save() never writes a path the handler did not touch', () => {
        // The original concern was balance; it was never at risk, and this says so.
        const doc = hydrate();
        doc.inventory = doc.inventory.filter(e => e.quantity > 0);
        expect(JSON.stringify(doc.$getChanges())).not.toContain('balance');
    });
});

describe('no /use handler cleans inventory by saving it', () => {
    test('every in-memory filter is paired with a $pull, not a bare save', () => {
        const lines = USE_SRC.split('\n');
        const offenders = [];

        lines.forEach((line, i) => {
            if (!/user\.inventory\s*=\s*user\.inventory\.filter/.test(line)) return;
            // Look at the handful of lines that follow: the cleanup must reach a
            // $pull, and any save() in between must be preceded by an unmark.
            const after = lines.slice(i + 1, i + 8);
            const stop = after.findIndex(l => /dropEmptyInventorySlots\(\)/.test(l));
            if (stop === -1) { offenders.push(`line ${i + 1}: filter with no $pull cleanup`); return; }
            const between = after.slice(0, stop);
            const saves = between.filter(l => /await user\.save\(\)/.test(l));
            const unmarked = between.some(l => /unmarkModified\('inventory'\)/.test(l));
            if (saves.length && !unmarked) offenders.push(`line ${i + 1}: save() writes the array back`);
        });

        expect(offenders).toEqual([]);
    });

    test('the cleanup pulls only emptied slots', () => {
        expect(USE_SRC).toContain('$pull: { inventory: { quantity: { $lte: 0 } } }');
        // One helper, so a new handler cannot invent a different rule.
        expect(USE_SRC.match(/\$pull: \{ inventory:/g) ?? []).toHaveLength(1);
    });

    test('every handler that empties a slot uses that one helper', () => {
        const filters = (USE_SRC.match(/user\.inventory\s*=\s*user\.inventory\.filter/g) ?? []).length;
        const cleanups = (USE_SRC.match(/dropEmptyInventorySlots\(\)/g) ?? []).length;
        expect(filters).toBeGreaterThan(0);
        // One definition plus one call per filtering handler, and the stamina
        // handler cleans up without needing a local filter.
        expect(cleanups).toBeGreaterThanOrEqual(filters + 1);
    });
});
