'use strict';

const fs = require('fs');
const path = require('path');

// A require inside a function body is not exercised until that branch runs, so
// a wrong path there is invisible to `require('...')` at load time and to every
// test that does not reach the branch. That is exactly how three broken
// `../../services/petService` requires survived the #721 split: they sat inside
// the pet-bonus branch of /fish cast, /hunt start and /mine dig, so the modules
// loaded fine and only a real cast would have thrown.
//
// This walks every relative require literal in src/ and resolves it.

const SRC = path.join(__dirname, '..', 'src');

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// Browser-side scripts are served to the page, not required by node.
const BROWSER_SCRIPTS = /^dashboard\/public\//;

const sourceFiles = walk(SRC)
    .map(full => ({
        full,
        rel: path.relative(SRC, full).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
    }))
    .filter(f => !BROWSER_SCRIPTS.test(f.rel));

describe('every relative require in src resolves', () => {
    test('no module requires a path that is not there', () => {
        const unresolved = [];

        for (const { full, rel, text } of sourceFiles) {
            for (const match of text.matchAll(/require\(\s*'(\.[^']*)'\s*\)/g)) {
                const target = match[1];
                try {
                    require.resolve(path.resolve(path.dirname(full), target));
                } catch {
                    unresolved.push(`${rel} -> ${target}`);
                }
            }
        }

        expect(unresolved).toEqual([]);
    });

    // If the scan stops matching, the test above passes by finding nothing.
    test('the scan actually found requires to check', () => {
        const count = sourceFiles
            .reduce((n, f) => n + [...f.text.matchAll(/require\(\s*'(\.[^']*)'\s*\)/g)].length, 0);

        expect(count).toBeGreaterThan(500);
    });
});
