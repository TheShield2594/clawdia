'use strict';

// docs/ITEM_IMAGE_COVERAGE.md is a checklist of 340 ids kept by hand across many
// sittings, which makes both halves of it fragile in different ways.
//
// The ids are the half a test can own: an item added to the game data has to
// show up here as an unticked line, or the person working through the list
// never learns it exists. That is the first check, and it is what `npm test`
// enforces.
//
// The ticks are the half a test must not touch — but it can prove they survive
// the rewrite that adds new ids, which is the failure that would cost real
// work: a regeneration that quietly reset a fortnight of them.

const fs = require('fs');

const {
    buildDoc,
    readState,
    applyTicks,
    catalogue,
    matcher,
    DOC_PATH,
    BANNER,
} = require('../scripts/item-image-coverage');

const { ACTIVITY_ITEM_IDS } = require('../src/data/activityItems');
const { DEFAULT_SHOP_ITEMS } = require('../src/data/defaultShopItems');

describe('docs/ITEM_IMAGE_COVERAGE.md', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');

    test('is in step with the catalog', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on a 340-line checklist is unreadable and the fix
        // is one command either way.
        expect(current === next).toBe(true);
    });

    test('says which half of it is generated', () => {
        expect(doc.startsWith(BANNER)).toBe(true);
    });

    test('has a line for every id the upload route accepts', () => {
        for (const id of ACTIVITY_ITEM_IDS) {
            expect([id, doc.includes(`\`${id}\``)]).toEqual([id, true]);
        }
    });

    test('has a line for every default shop item', () => {
        for (const item of DEFAULT_SHOP_ITEMS) {
            expect([item.itemId, doc.includes(`\`${item.itemId}\``)]).toEqual([item.itemId, true]);
        }
    });

    test('lists nothing the image system cannot store', () => {
        const listed = [...doc.matchAll(/^- \[[ x]\] `([^`]+)`/gm)].map(match => match[1]);
        const storable = new Set([...ACTIVITY_ITEM_IDS, ...DEFAULT_SHOP_ITEMS.map(i => i.itemId)]);

        expect(listed.filter(id => !storable.has(id))).toEqual([]);
    });

    test('counts the same ids in its summary as it lists', () => {
        const listed = (doc.match(/^- \[[ x]\]/gm) || []).length;
        const total = catalogue().reduce((n, group) => n + group.items.length, 0);

        expect(listed).toBe(total);
        expect(doc).toContain(`**${(doc.match(/^- \[x\]/gm) || []).length} of ${total} done.**`);
    });
});

describe('the ticks', () => {
    test('survive the rewrite that adds new ids', () => {
        const state = readState(fs.readFileSync(DOC_PATH, 'utf8'));
        const { next } = buildDoc(state);

        expect(readState(next)).toEqual(state);
    });

    test('carry their note across, so nobody re-derives where the art came from', () => {
        const state = new Map([['fish:koi', { done: true, note: 'cozy fishing pack' }]]);
        const { next } = buildDoc(state);

        expect(next).toContain('- [x] `fish:koi` — Koi · cozy fishing pack');
        expect(readState(next).get('fish:koi')).toEqual({ done: true, note: 'cozy fishing pack' });
    });

    test('read back the same whether or not a line carries a note', () => {
        const state = new Map([['fish:koi', { done: true, note: '' }]]);
        const { next } = buildDoc(state);

        expect(next).toContain('- [x] `fish:koi` — Koi\n');
        expect(readState(next).get('fish:koi')).toEqual({ done: true, note: '' });
    });
});

describe('--tick', () => {
    const freshState = () => new Map();

    test('marks one id and says it changed something', () => {
        const state = freshState();

        expect(applyTicks(state, ['fish:koi'], true)).toBe(1);
        expect(state.get('fish:koi')).toEqual({ done: true, note: '' });
    });

    test('takes a note after `=`', () => {
        const state = freshState();
        applyTicks(state, ['fish:koi=cozy fishing pack'], true);

        expect(state.get('fish:koi').note).toBe('cozy fishing pack');
    });

    // 59 fish from one pack is one command, not 59.
    test('accepts a wildcard, and only touches ids that exist', () => {
        const state = freshState();
        const changed = applyTicks(state, ['material:*'], true);

        expect(changed).toBe(69);
        expect(state.get('material:fish_scale')).toEqual({ done: true, note: '' });
        expect(state.has('material:not_a_material')).toBe(false);
    });

    test('reports nothing changed when the pattern matches no id', () => {
        expect(applyTicks(freshState(), ['fish:no_such_fish'], true)).toBe(0);
    });

    test('re-ticking with a new note replaces the old one', () => {
        const state = new Map([['fish:koi', { done: true, note: 'placeholder' }]]);
        applyTicks(state, ['fish:koi=final art'], true);

        expect(state.get('fish:koi').note).toBe('final art');
    });

    // Unticking is for art that was replaced or withdrawn, so the note goes with
    // it — a note beside an unticked box describes art that is not there.
    test('unticking clears the note as well as the box', () => {
        const state = new Map([['fish:koi', { done: true, note: 'cozy fishing pack' }]]);
        applyTicks(state, ['fish:koi'], false);

        expect(state.get('fish:koi')).toEqual({ done: false, note: '' });
    });

    test('matches a wildcard as a wildcard and a dot as a dot', () => {
        expect(matcher('fish:*').test('fish:koi')).toBe(true);
        expect(matcher('fish:*').test('hunt:rabbit')).toBe(false);
        expect(matcher('fish:koi').test('fish:koibbb')).toBe(false);
    });
});
