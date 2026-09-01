'use strict';

/**
 * #867. Migration 021, driven against a fake driver.
 *
 * tests/integration/migrations.test.js applies it against a real mongod, which
 * is where "does MongoDB accept this collMod" is answered. What that suite
 * cannot reach cheaply is the branches either side of the happy path: a fresh
 * install with no collection, a database whose index was dropped by hand, an
 * already-migrated one, and the verification that refuses to let the boot
 * continue if the TTL is still deleting listings afterwards. Those are decided
 * entirely by what comes back from `indexes()`, so they are stated here.
 *
 * The command shape matters as much as the outcome: `collMod` rather than a
 * drop and recreate is what keeps the collection from spending an interval with
 * no TTL on it at all, and keeps the index from being rebuilt over every
 * listing on a large install.
 */

// The real mongoose, with only `connection.db` swapped for a fake. Mocking the
// module outright would take `Schema` and `model` with it, and the grace under
// test is exported by a model.
const mongoose = require('mongoose');
const migration = require('../src/migrations/021_market_listing_ttl_grace');
const { EXPIRED_LISTING_GRACE_SECONDS: GRACE } = require('../src/models/MarketListing');

/**
 * A `mongoose.connection.db` with just the surface the migration touches.
 *
 * `indexes` is a list the fake mutates, so a call after a collMod sees what the
 * collMod did — which is the whole point of the verification step.
 */
function fakeDb({ collectionExists = true, indexes = [] } = {}) {
    // Copied per index, not just per array: the collMod fake mutates what it
    // finds, and the fixtures below are shared between tests.
    const state = { indexes: indexes.map(i => ({ ...i })), commands: [], created: [] };

    state.db = {
        listCollections: () => ({ toArray: async () => (collectionExists ? [{ name: 'marketlistings' }] : []) }),
        collection: name => {
            expect(name).toBe('marketlistings');
            return {
                indexes: async () => state.indexes.map(i => ({ ...i })),
                createIndex: async (key, options) => {
                    state.created.push({ key, options });
                    state.indexes.push({ name: 'expiresAt_1', key, expireAfterSeconds: options.expireAfterSeconds });
                },
            };
        },
        command: async cmd => {
            state.commands.push(cmd);
            const target = state.indexes.find(i => i.name === cmd.index.name);
            if (target) target.expireAfterSeconds = cmd.index.expireAfterSeconds;
            return { ok: 1 };
        },
    };
    mongoose.connection.db = state.db;
    return state;
}

const zeroGrace = { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 };
const withGrace = { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: GRACE };

afterEach(() => { mongoose.connection.db = null; });

describe('021_market_listing_ttl_grace, up', () => {
    test('widens the zero-grace TTL in place', async () => {
        const state = fakeDb({ indexes: [zeroGrace] });

        await migration.up();

        expect(state.commands).toEqual([{
            collMod: 'marketlistings',
            index: { name: 'expiresAt_1', expireAfterSeconds: GRACE },
        }]);
    });

    test('does not drop and recreate the index', async () => {
        // A drop-and-recreate leaves the collection with no TTL in between and
        // rebuilds the index over every listing on a large install. collMod is
        // the reason neither happens, so it is asserted rather than assumed.
        const state = fakeDb({ indexes: [zeroGrace] });

        await migration.up();

        expect(state.created).toEqual([]);
    });

    test('does nothing on a database that has already been migrated', async () => {
        const state = fakeDb({ indexes: [withGrace] });

        await migration.up();

        expect(state.commands).toEqual([]);
        expect(state.created).toEqual([]);
    });

    test('does nothing on a fresh install with no listings collection', async () => {
        // The model's own declaration builds the index with the grace already
        // on it the first time someone lists an item.
        const state = fakeDb({ collectionExists: false });

        await migration.up();

        expect(state.commands).toEqual([]);
        expect(state.created).toEqual([]);
    });

    test('builds the index when the collection exists without one', async () => {
        // A database that predates the index, or one where it was dropped by
        // hand. Built here and awaited rather than left to autoIndex, which
        // runs unawaited and would leave the sweep's `expiresAt` query
        // unindexed until it caught up.
        const state = fakeDb({ indexes: [] });

        await migration.up();

        expect(state.created).toEqual([{ key: { expiresAt: 1 }, options: { expireAfterSeconds: GRACE } }]);
        expect(state.commands).toEqual([]);
    });

    test('refuses to let the boot continue if the TTL is still zero afterwards', async () => {
        // The failure this migration exists to prevent, verified rather than
        // assumed: a TTL left at zero goes on destroying listings before the
        // sweep can return the seller's items, and a boot that carried on would
        // do it silently.
        const state = fakeDb({ indexes: [zeroGrace] });
        state.db.command = async () => ({ ok: 1 }); // accepted, changed nothing

        await expect(migration.up()).rejects.toThrow(/still expires after 0s/);
    });
});

describe('021_market_listing_ttl_grace, down', () => {
    test('puts the zero-grace TTL back', async () => {
        // A rollback to a state that loses items, which is what a rollback to
        // the previous release is — the code being rolled back to is the code
        // that shipped the zero.
        const state = fakeDb({ indexes: [withGrace] });

        await migration.down();

        expect(state.commands).toEqual([{
            collMod: 'marketlistings',
            index: { name: 'expiresAt_1', expireAfterSeconds: 0 },
        }]);
    });

    test('is a no-op where there is nothing to put back', async () => {
        const noCollection = fakeDb({ collectionExists: false });
        await migration.down();
        expect(noCollection.commands).toEqual([]);

        const noIndex = fakeDb({ indexes: [] });
        await migration.down();
        expect(noIndex.commands).toEqual([]);
    });
});
