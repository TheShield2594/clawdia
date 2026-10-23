'use strict';

/**
 * Migration 028, driven against a fake driver (#1186).
 *
 * Bond moved from days-since-adoption to a stored, care-earned value. Existing
 * pets would otherwise read as zero, so the migration seeds each from its age,
 * capped below the top tiers. Pinned here: the filter picks only users with an
 * unseeded pet, the per-index write touches only pets missing a bond, the cap
 * holds, and a memorial pet takes the runaway penalty.
 */

const mongoose = require('mongoose');
const migration = require('../src/migrations/028_seed_pet_bond');

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

function fakeDb(userDocs) {
    const state = { calls: [], manyCalls: [], findFilter: null };
    mongoose.connection.db = {
        collection: () => ({
            find: (filter) => {
                state.findFilter = filter;
                return { async *[Symbol.asyncIterator]() { for (const u of userDocs) yield u; } };
            },
            updateOne: async (filter, update) => {
                state.calls.push({ filter, update });
                return { modifiedCount: 1 };
            },
            updateMany: async (filter, update) => {
                state.manyCalls.push({ filter, update });
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

describe('028_seed_pet_bond', () => {
    test('is reversible under its own name', () => {
        expect(migration.name).toBe('028_seed_pet_bond');
        expect(migration.irreversible).toBeUndefined();
        expect(typeof migration.down).toBe('function');
    });

    test('selects only users holding a pet with no bond', async () => {
        const state = fakeDb([]);
        await migration.up();
        const missing = { $elemMatch: { bond: { $exists: false } } };
        expect(state.findFilter).toEqual({ $or: [{ pets: missing }, { deceasedPets: missing }] });
    });

    test('seeds one point per two days, capped at 50, and leaves seeded pets alone', async () => {
        const state = fakeDb([{
            _id: 'u1',
            pets: [
                { adoptedAt: daysAgo(21) },           // 10
                { adoptedAt: daysAgo(400) },          // capped
                { adoptedAt: daysAgo(90), bond: 7 },  // already has one
                { adoptedAt: null },                  // unknown age
            ],
        }]);

        await migration.up();

        expect(state.calls).toEqual([{
            filter: { _id: 'u1' },
            update: { $set: { 'pets.0.bond': 10, 'pets.1.bond': 50, 'pets.3.bond': 0 } },
        }]);
    });

    test('a memorial pet is seeded to when it ran off, less the runaway penalty', async () => {
        const state = fakeDb([{
            _id: 'u1',
            deceasedPets: [
                { adoptedAt: daysAgo(200), diedAt: daysAgo(100) }, // 50 → 25
                { adoptedAt: daysAgo(30),  diedAt: daysAgo(10) },  // 10 → 0
            ],
        }]);

        await migration.up();

        expect(state.calls[0].update).toEqual({ $set: { 'deceasedPets.0.bond': 25, 'deceasedPets.1.bond': 0 } });
    });

    test('a user with nothing to seed is not written', async () => {
        const state = fakeDb([{ _id: 'u1', pets: [{ adoptedAt: daysAgo(10), bond: 3 }] }]);
        await migration.up();
        expect(state.calls).toEqual([]);
    });

    test('down drops bond and its daily-cap fields from both arrays', async () => {
        const state = fakeDb([]);
        await migration.down();
        expect(state.manyCalls).toEqual([
            {
                filter: { 'pets.0': { $exists: true } },
                update: { $unset: { 'pets.$[].bond': '', 'pets.$[].bondDay': '', 'pets.$[].bondToday': '' } },
            },
            {
                filter: { 'deceasedPets.0': { $exists: true } },
                update: { $unset: { 'deceasedPets.$[].bond': '', 'deceasedPets.$[].bondDay': '', 'deceasedPets.$[].bondToday': '' } },
            },
        ]);
    });
});
