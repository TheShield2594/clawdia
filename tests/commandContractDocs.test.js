'use strict';

// The command-module contract is a duck-typed object: `interactionCreate` reads
// `command.cooldownAmount`, `command.cooldownKey`, `command.autocomplete` and
// `command.requiredPermissions` by name, and nothing validates that any of them
// exist or are spelled right. For a long time the guide documented three of the
// eight keys (#719), so four commands were using hooks a contributor reading the
// docs had no way to know about — and a fifth key was a permission gate.
//
// A table in a markdown file drifts the moment someone adds a hook, so this
// holds the two together: read a new `command.<key>` in the handler or the
// loader and `npm test` goes red until docs/EXTENDING.md has a row for it.

const fs = require('fs');
const path = require('path');

const GUIDE = path.join(__dirname, '../docs/EXTENDING.md');
const SOURCES = [
    path.join(__dirname, '../src/events/interactionCreate.js'),
    path.join(__dirname, '../src/utils/commandLoader.js'),
];

// The contract table is the one under this heading; the guide has other tables.
const TABLE_HEADING = '### The full module contract';

function documentedKeys() {
    const guide = fs.readFileSync(GUIDE, 'utf8');
    const start = guide.indexOf(TABLE_HEADING);
    if (start === -1) throw new Error(`"${TABLE_HEADING}" is gone from docs/EXTENDING.md`);

    // Up to the next heading of the same or higher level, so the sub-sections
    // below the table (which quote keys in prose) cannot pad the set.
    const rest = guide.slice(start + TABLE_HEADING.length);
    const end = rest.search(/\n#{1,3} /);
    const section = end === -1 ? rest : rest.slice(0, end);

    return new Set(
        [...section.matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map(m => m[1]),
    );
}

function keysReadFromModules() {
    const keys = new Set();
    for (const file of SOURCES) {
        const src = fs.readFileSync(file, 'utf8');
        // `command.data`, `command.data?.toJSON`, `command.cooldownKey` — the
        // first hop is the contract key, which is all this needs.
        for (const m of src.matchAll(/\bcommand\.(\w+)/g)) keys.add(m[1]);
    }
    return keys;
}

describe('command-module contract', () => {
    test('every key the handler and loader read has a row in the guide', () => {
        const documented = documentedKeys();
        const undocumented = [...keysReadFromModules()].filter(k => !documented.has(k));

        expect(undocumented).toEqual([]);
    });

    test('the guide does not document keys nothing reads', () => {
        const read = keysReadFromModules();
        const invented = [...documentedKeys()].filter(k => !read.has(k));

        expect(invented).toEqual([]);
    });

    // The rows are only worth holding to if they name the keys that are actually
    // load-bearing, so pin the ones a wrong spelling breaks silently.
    test.each(['data', 'execute', 'cooldown', 'cooldownAmount', 'cooldownKey', 'autocomplete', 'requiredPermissions', 'category'])(
        'documents %s',
        key => expect(documentedKeys().has(key)).toBe(true),
    );
});
