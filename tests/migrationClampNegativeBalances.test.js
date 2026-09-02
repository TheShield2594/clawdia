'use strict';

/**
 * #950. Migration 011, driven against a fake driver.
 *
 * `tests/integration/migrations.test.js` already applies this against a real
 * mongod and asserts the outcome — a seeded `{ balance: -50, bank: -10 }` comes
 * back `{ balance: 0, bank: 0 }` with a healthy neighbour untouched. That is the
 * question a server has to answer, and it is answered there.
 *
 * What it cannot answer is anything about *how* the repair is written, and this
 * is the repair path for balance corruption that actually happened: the
 * migration exists because negative balances existed. Its value now is as the
 * reference implementation for the next clamp migration and as the chain a new
 * install replays, and both of those depend on the shape of the write rather
 * than on the numbers coming out of it — so the shape is stated here, where it
 * is also reachable on a machine that cannot fetch a mongod binary and where
 * the file was otherwise loaded and never run.
 *
 * Three things are worth holding:
 *
 *   1. Both fields, each with its own `updateMany`. `balance` and `bank` are
 *      separate `min: 0` paths and a document can be negative in either.
 *   2. A filter that selects only the damaged documents. `{ $lt: 0 }` and not a
 *      match-all with a `$max` in the pipeline: the second would rewrite every
 *      user document in the database to repair the handful that need it.
 *   3. The count is logged when there is damage and not when there is none. The
 *      migration is irreversible and the negative values are overwritten rather
 *      than recorded, so that log line is the only trace of how much there was.
 */

// The real mongoose with only `connection.db` swapped, matching
// tests/migrationMarketTtlGrace.test.js: mocking the module outright would take
// `Schema` and `model` with it.
const mongoose = require('mongoose');
const migration = require('../src/migrations/011_clamp_negative_balances');

/**
 * A `mongoose.connection.db` exposing just `collection('users').updateMany`,
 * recording every call and answering with the modified count it is handed.
 */
function fakeDb(modifiedCounts = []) {
    const state = { calls: [], collections: [] };
    const answers = [...modifiedCounts];

    mongoose.connection.db = {
        collection: name => {
            state.collections.push(name);
            return {
                updateMany: async (filter, update) => {
                    state.calls.push({ filter, update });
                    return { modifiedCount: answers.shift() ?? 0 };
                },
            };
        },
    };
    return state;
}

let logged;
beforeEach(() => { logged = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => {
    logged.mockRestore();
    mongoose.connection.db = null;
});

describe('011_clamp_negative_balances', () => {
    test('is declared irreversible under its own name', () => {
        // The runner reads both: the name is the key in `migrationrecords` that
        // decides whether this has run, and `irreversible` is what makes the
        // runner take the pre-migration dump that is the only way back.
        expect(migration.name).toBe('011_clamp_negative_balances');
        expect(migration.irreversible).toBe(true);
        expect(migration.down).toBeUndefined();
    });

    test('repairs balance and bank, one update each', async () => {
        const state = fakeDb();

        await migration.up();

        // One handle, two updates: the collection is resolved once outside the
        // field loop.
        expect(state.collections).toEqual(['users']);
        expect(state.calls.map(c => c.filter)).toEqual([
            { balance: { $lt: 0 } },
            { bank: { $lt: 0 } },
        ]);
    });

    // The whole point of the filter. A match-all update with the clamp in the
    // pipeline would produce the same balances and rewrite every user document
    // in the database to do it, on a migration that runs at boot.
    test('touches only the documents that are actually negative', async () => {
        const state = fakeDb();

        await migration.up();

        for (const { filter } of state.calls) {
            expect(Object.values(filter)).toEqual([{ $lt: 0 }]);
        }
    });

    test('sets the field to zero rather than incrementing it', async () => {
        // A `$inc` would need to know how negative each document was; the repair
        // is a floor, and zero is the value every damaged document ends at.
        const state = fakeDb();

        await migration.up();

        expect(state.calls.map(c => c.update)).toEqual([
            [{ $set: { balance: 0 } }],
            [{ $set: { bank: 0 } }],
        ]);
    });

    test('logs how much damage each field had', async () => {
        fakeDb([3, 7]);

        await migration.up();

        const lines = logged.mock.calls.map(args => args.join(' '));
        expect(lines).toEqual([
            '[MIGRATIONS] 011: clamped 3 negative balance(s) to 0.',
            '[MIGRATIONS] 011: clamped 7 negative bank(s) to 0.',
        ]);
    });

    // The state every deployment that has already run this is in, and the state
    // a fresh install replaying the chain is in. Silence is the correct output:
    // a line per field per boot would report damage that is not there.
    test('says nothing when there is nothing to repair', async () => {
        fakeDb([0, 0]);

        await migration.up();

        expect(logged).not.toHaveBeenCalled();
    });

    test('still repairs bank when only balance had damage', async () => {
        // The two updates are independent — a document can be negative in one
        // field and healthy in the other — so an early return on a zero count
        // would leave the second field corrupt.
        const state = fakeDb([2, 0]);

        await migration.up();

        expect(state.calls).toHaveLength(2);
        expect(logged.mock.calls.map(args => args.join(' '))).toEqual([
            '[MIGRATIONS] 011: clamped 2 negative balance(s) to 0.',
        ]);
    });
});
