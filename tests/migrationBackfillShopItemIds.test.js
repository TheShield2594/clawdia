'use strict';

/**
 * Migration 026, driven against a fake driver.
 *
 * Older guilds carry default shop items seeded before the `itemId` field
 * existed, so their id is null and the baked catalogue icon (keyed by id) never
 * resolves — the /shop view falls back to the white emoji glyph. This migration
 * recovers the id from the display name for exactly those rows.
 *
 * The real mongod path is covered in tests/integration/migrations.test.js; what
 * is pinned here is the shape of the sweep on a machine that cannot fetch a
 * mongod binary: the filter selects only guilds that need it, only id-less rows
 * are written, a custom item whose name is not in the catalogue is left alone,
 * and the write is a targeted per-index $set rather than an array-wide stamp.
 */

const mongoose = require('mongoose');
const migration = require('../src/migrations/026_backfill_shop_item_ids');

/**
 * A `mongoose.connection.db` exposing `collection('guilds')` with a `find` that
 * replays the seeded guilds and an `updateOne` that records every write.
 */
function fakeDb(guildDocs) {
    const state = { calls: [], findFilter: null, findOptions: null };

    mongoose.connection.db = {
        collection: () => ({
            find: (filter, options) => {
                state.findFilter = filter;
                state.findOptions = options;
                return {
                    async *[Symbol.asyncIterator]() {
                        for (const g of guildDocs) yield g;
                    },
                };
            },
            updateOne: async (filter, update) => {
                state.calls.push({ filter, update });
                return { modifiedCount: 1 };
            },
        }),
    };
    return state;
}

let logged;
beforeEach(() => { logged = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => {
    logged.mockRestore();
    mongoose.connection.db = null;
});

describe('026_backfill_shop_item_ids', () => {
    test('is declared irreversible under its own name', () => {
        expect(migration.name).toBe('026_backfill_shop_item_ids');
        expect(migration.irreversible).toBe(true);
        expect(migration.down).toBeUndefined();
    });

    test('selects only guilds holding an id-less shop item', async () => {
        const state = fakeDb([]);

        await migration.up();

        expect(state.findFilter).toEqual({
            shop: {
                $elemMatch: {
                    $or: [{ itemId: null }, { itemId: '' }, { itemId: { $exists: false } }],
                },
            },
        });
    });

    test('recovers the catalogue id for id-less default items by name', async () => {
        const state = fakeDb([{
            _id: 'g1',
            shop: [
                { name: 'Knife', itemId: null },
                { name: 'Shield', itemId: null },
            ],
        }]);

        await migration.up();

        expect(state.calls).toEqual([{
            filter: { _id: 'g1' },
            update: { $set: { 'shop.0.itemId': 'knife', 'shop.1.itemId': 'shield' } },
        }]);
    });

    test('leaves rows that already have an id untouched', async () => {
        const state = fakeDb([{
            _id: 'g1',
            shop: [
                { name: 'Knife', itemId: 'knife' },     // already tagged
                { name: 'Lifesaver', itemId: null },    // needs recovery
            ],
        }]);

        await migration.up();

        expect(state.calls).toEqual([{
            filter: { _id: 'g1' },
            update: { $set: { 'shop.1.itemId': 'lifesaver' } },
        }]);
    });

    test('leaves a custom item whose name is not in the catalogue as null', async () => {
        const state = fakeDb([{
            _id: 'g1',
            shop: [
                { name: 'Homebrew Widget', itemId: null },  // not a catalogue name
                { name: 'Padlock', itemId: null },          // recoverable
            ],
        }]);

        await migration.up();

        expect(state.calls).toEqual([{
            filter: { _id: 'g1' },
            update: { $set: { 'shop.1.itemId': 'padlock' } },
        }]);
    });

    test('issues no write for a guild with nothing recoverable', async () => {
        const state = fakeDb([{
            _id: 'g1',
            shop: [{ name: 'Homebrew Widget', itemId: null }],
        }]);

        await migration.up();

        expect(state.calls).toHaveLength(0);
        expect(logged).not.toHaveBeenCalled();
    });

    test('logs the totals only when something was fixed', async () => {
        fakeDb([
            { _id: 'g1', shop: [{ name: 'Knife', itemId: null }] },
            { _id: 'g2', shop: [{ name: 'Shield', itemId: null }, { name: 'Padlock', itemId: null }] },
        ]);

        await migration.up();

        expect(logged.mock.calls.map(a => a.join(' '))).toEqual([
            '[MIGRATIONS] 026: backfilled 3 shop item id(s) across 2 guild(s).',
        ]);
    });

    test('passes the migration budget to the cursor as maxTimeMS', async () => {
        const state = fakeDb([]);

        await migration.up({ timeoutMs: 45_000 });

        expect(state.findOptions).toMatchObject({ maxTimeMS: 45_000 });
    });
});
