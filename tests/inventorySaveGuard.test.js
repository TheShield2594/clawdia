'use strict';

// Inventory credits land through the aggregation-pipeline upsert in
// src/utils/inventoryGrant.js, never through `save()`. The dangerous shape is a
// find-then-push (or `slot.quantity += n`) on an in-memory document that a
// later `save()` writes back: the whole array goes out as an absolute `$set`
// when the path is marked modified, flattening any credit that landed since the
// read — and two concurrent credits that both miss the slot each push their
// own, stranding the second slot's quantity behind every `find()`-first reader
// (issue #573).
//
// This scan pins the sweep that removed those sites. It is spelling-based
// rather than AST-based on purpose: the two spellings below are exactly the
// ones the unsafe shape needs, they have no legitimate new use, and a scan that
// flags a rare false positive is cheaper than one that misses a real credit.
//
//   - `.inventory.push(`            the miss half of check-then-push
//   - `markModified('inventory')`   forces the whole array into the next save
//
// (`unmarkModified('inventory')` is the *fix* — use.js and explore.js detach
// the array from a save — so the match requires the un-prefix to be absent.)

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Verified by hand, and only these.
const REVIEWED = new Map([
    // The relic mutation keeps the in-memory inventory current for the
    // encounter-stakes math and the reply, but explore.js detaches it from the
    // pre-encounter save (`unmarkModified('inventory')`) and re-applies it as a
    // grantInventoryItem upsert right after.
    ['services/exploreService.js', 'relic mutation is detached from the save by explore.js and re-applied atomically'],
    // decrementMaterial spends a grind material when feeding a pet — a debit,
    // not a credit, cascading across hunt/fishing/mining stores that all live
    // in the same save. Concurrency here can strand a unit of pet food, not
    // mint one. Reworking it means reshaping the material stores; tracked as
    // its own problem rather than waved through silently.
    ['commands/economy/pet.js', 'decrementMaterial is a clamped debit of grind materials, not a credit'],
    // Not a User inventory at all: `applyEffects` builds a copy of the DM
    // party's character list and pushes an adventuring item onto that copy, and
    // dmService writes the result back through an explicit `$set` under the
    // session's turn lease. There is no `save()` anywhere on the path, and
    // nothing here is worth coins.
    ['services/dm/effects.js', 'DmSession party inventory, on a local copy, written back as an explicit $set'],
]);

const PATTERN = /\.inventory\.push\(|(?<!un)markModified\(['"]inventory['"]\)/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function findHits() {
    const hits = [];
    for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (PATTERN.test(line)) hits.push({ rel, line: i + 1, text: line.trim() });
        });
    }
    return hits;
}

describe('inventory credits never ride a save()', () => {
    const hits = findHits();

    test('every in-memory inventory mutation is a reviewed exception', () => {
        // Route new sites through src/utils/inventoryGrant.js, or detach them
        // from the save the way explore.js does.
        const unreviewed = hits
            .filter(h => !REVIEWED.has(h.rel))
            .map(h => `${h.rel}:${h.line}  ${h.text}`);
        expect(unreviewed).toEqual([]);
    });

    test('no stale exemptions: every reviewed file still contains the pattern', () => {
        const present = new Set(hits.map(h => h.rel));
        const stale = [...REVIEWED.keys()].filter(rel => !present.has(rel));
        expect(stale).toEqual([]);
    });

    // The scan is only as good as its spellings; prove each one still matches.
    test('the pattern recognises both unsafe spellings and skips the fix', () => {
        expect(PATTERN.test("user.inventory.push({ itemId: 'x', quantity: 1 });")).toBe(true);
        expect(PATTERN.test("user.markModified('inventory');")).toBe(true);
        expect(PATTERN.test('user.markModified("inventory");')).toBe(true);
        expect(PATTERN.test("user.unmarkModified('inventory');")).toBe(false);
        expect(PATTERN.test("user.markModified('exploration');")).toBe(false);
    });
});
