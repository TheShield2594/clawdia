'use strict';

// docs/ECONOMY_ITEMS.md is the list item art is named from, and a list of 500
// ids is wrong within a week of being written by hand. It is generated, and
// this is what keeps it generated: adding a weapon, a fish, an ore, a shop item
// or an event loot table turns `npm test` red until `npm run docs:items` has
// been run.
//
// The checks below the first one are about the ids themselves. An id printed
// with a typo, a stray space or an unescaped pipe is an icon filed under a name
// nothing ever asks for, which is exactly the failure the doc exists to stop.

const fs = require('fs');

const {
    buildDoc,
    renderTable,
    section,
    uploadableIndex,
    escapeCell,
    DOC_PATH,
    BANNER,
} = require('../scripts/docs-items');

const { ACTIVITY_ITEM_IDS } = require('../src/data/activityItems');
const { DEFAULT_SHOP_ITEMS } = require('../src/data/defaultShopItems');

describe('docs/ECONOMY_ITEMS.md', () => {
    test('is in step with the economy data', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on a 500-row document is unreadable and the fix
        // is one command either way.
        expect(current === next).toBe(true);
    });

    test('says it is generated, so nobody edits it by hand', () => {
        expect(fs.readFileSync(DOC_PATH, 'utf8').startsWith(BANNER)).toBe(true);
    });

    test('lists every id the upload route accepts', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');

        for (const id of ACTIVITY_ITEM_IDS) {
            expect([id, doc.includes(`\`${id}\``)]).toEqual([id, true]);
        }
    });

    test('lists every default shop item', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');

        for (const item of DEFAULT_SHOP_ITEMS) {
            expect([item.itemId, doc.includes(`\`${item.itemId}\``)]).toEqual([item.itemId, true]);
        }
    });

    // The index at the end is what someone batch-renames a folder of PNGs
    // against, so it has to be the whole set and nothing invented.
    test('closes on an index of exactly the uploadable ids', () => {
        const indexed = uploadableIndex()
            .split('\n')
            .filter(line => line && !line.startsWith('#'))
            .map(line => line.split(/\s{2,}/)[0]);

        expect(indexed.sort()).toEqual([...ACTIVITY_ITEM_IDS].sort());
    });
});

describe('the ids it prints', () => {
    const { next } = buildDoc();
    const ids = [...next.matchAll(/^\| `([^`]+)`/gm)].map(match => match[1]);

    test('are one row per item within a table', () => {
        // Ids repeat across tables on purpose — an event shop sells the loot
        // box the event's own table names — so this is per table, not global.
        for (const table of next.split(/\n\n/).filter(block => block.startsWith('| Item ID'))) {
            const rows = [...table.matchAll(/^\| `([^`]+)`/gm)].map(match => match[1]);
            expect(rows).toEqual([...new Set(rows)]);
        }
    });

    test('carry no leading or trailing whitespace', () => {
        for (const id of ids) expect([id, id.trim()]).toEqual([id, id]);
    });

    // Three shapes exist in the data: a plain key (`padlock`, and the camelCase
    // field-trophy flags), the namespaced ids the image system stores an item
    // under — `hunt:wooden_rifle`, `material:fish_scale` — and the relic ids,
    // which are display names ("Whisperwood Charm"). Anything else is a field
    // read off the wrong key.
    test('are a plain key, a namespaced id, or a relic name', () => {
        for (const id of ids) {
            const shape = /^[a-zA-Z0-9_]+$/.test(id)
                || /^(hunt|fish|mine|material):[a-z0-9_]+$/.test(id)
                || /^[A-Z][A-Za-z'’()\- ]+$/.test(id);
            expect([id, shape]).toEqual([id, true]);
        }
    });

    test('never say "undefined", which is a field read off the wrong key', () => {
        expect(ids.filter(id => id.includes('undefined'))).toEqual([]);
    });
});

describe('the generator itself', () => {
    test('escapes a pipe in a name rather than splitting the cell', () => {
        expect(escapeCell('Rod | Reel')).toBe('Rod \\| Reel');
    });

    test('counts the rows in a heading, so a short table is visible as one', () => {
        const body = section('Probes', [{ id: 'probe_a', name: 'Probe A', emoji: '🧪' }]);

        expect(body).toContain('### Probes (1)');
        expect(body).toContain('| `probe_a` | Probe A | 🧪 |');
    });

    // An empty table means a collection was renamed and is now being read off a
    // key that does not exist. Failing loudly beats printing a heading with
    // nothing under it.
    test('refuses to render a section with no rows', () => {
        expect(() => section('Probes', [])).toThrow(/no rows/);
    });

    test('renders a header row even for a single item', () => {
        expect(renderTable([{ id: 'a', name: 'A', emoji: '' }]).split('\n')).toHaveLength(3);
    });

    // The milestone drop table rolls a Lifesaver at both streak 7 and streak
    // 100. That is two rolls of one item, not two items to draw.
    test('prints an item once even when the data lists it twice', () => {
        const body = section('Probes', [
            { id: 'probe_a', name: 'Probe A', emoji: '🧪' },
            { id: 'probe_a', name: 'Probe A', emoji: '🧪' },
        ]);

        expect(body).toContain('### Probes (1)');
        expect(body.match(/probe_a/g)).toHaveLength(1);
    });
});
