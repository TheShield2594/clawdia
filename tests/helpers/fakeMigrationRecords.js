'use strict';

/**
 * An in-memory stand-in for the MigrationRecord model.
 *
 * The runner's bookkeeping is a two-phase claim over a unique `name` (#654), so
 * a mock that only implements find and create cannot see the thing that
 * matters: the duplicate-key error a losing insert gets. This one raises it,
 * with the driver's `code: 11000`, which is what `isDuplicateKey` reads.
 *
 *   const mockRecords = fakeMigrationRecords();
 *   jest.mock('../src/models/MigrationRecord', () => mockRecords.model);
 *   mockRecords.rows          // every record, in insertion order
 *   mockRecords.seed({ name: '001_a' })
 *
 * The `mock` prefix is not decoration: jest hoists `jest.mock` above the file's
 * own declarations and refuses a factory that closes over anything else.
 */

const clone = row => (row ? { ...row } : null);

const sameValue = (a, b) => {
    if (a instanceof Date || b instanceof Date) {
        if (a == null || b == null) return (a ?? null) === (b ?? null);
        return new Date(a).getTime() === new Date(b).getTime();
    }
    // Mongo matches `{ field: null }` against a document that has no such field,
    // which is what the takeover's compare-and-set relies on for records written
    // before `owner` existed.
    if (a == null || b == null) return (a ?? null) === (b ?? null);
    return a === b;
};

/** The handful of query shapes the runner issues, and nothing else. */
function matches(row, filter = {}) {
    return Object.entries(filter).every(([field, condition]) => {
        const value = row[field];
        if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
            if ('$in' in condition) return condition.$in.includes(value);
            if ('$ne' in condition) return !sameValue(value, condition.$ne);
            throw new Error(`fakeMigrationRecords: unsupported condition on ${field}: ${JSON.stringify(condition)}`);
        }
        return sameValue(value, condition);
    });
}

function fakeMigrationRecords() {
    const rows = [];

    /** What mongod answers a second insert of the same unique name with. */
    const duplicateKeyError = name => Object.assign(
        new Error(`E11000 duplicate key error collection: test.migrationrecords index: name_1 dup key: { name: "${name}" }`),
        { code: 11000, name: 'MongoServerError' },
    );

    const model = {
        find: (filter = {}) => ({
            lean: async () => rows.filter(row => matches(row, filter)).map(row => ({ name: row.name })),
        }),

        findOne: (filter = {}) => ({
            lean: async () => clone(rows.find(row => matches(row, filter))),
        }),

        create: async doc => {
            if (rows.some(row => row.name === doc.name)) throw duplicateKeyError(doc.name);
            // Mirrors the schema's own defaults: a record written without a
            // state is a finished one.
            const row = { state: 'complete', startedAt: null, owner: null, appliedAt: new Date(), durationMs: null, ...doc };
            rows.push(row);
            return clone(row);
        },

        updateOne: async (filter = {}, update = {}) => {
            const row = rows.find(r => matches(r, filter));
            if (!row) return { matchedCount: 0, modifiedCount: 0 };
            Object.assign(row, update.$set ?? {});
            return { matchedCount: 1, modifiedCount: 1 };
        },

        findOneAndUpdate: async (filter = {}, update = {}) => {
            const row = rows.find(r => matches(r, filter));
            if (!row) return null;
            const before = clone(row);
            Object.assign(row, update.$set ?? {});
            return before;
        },

        deleteOne: async (filter = {}) => {
            const at = rows.findIndex(row => matches(row, filter));
            if (at === -1) return { deletedCount: 0 };
            rows.splice(at, 1);
            return { deletedCount: 1 };
        },

        modelName: 'MigrationRecord',
    };

    return {
        model,
        rows,
        seed: (fields = {}) => {
            const row = { state: 'complete', startedAt: null, owner: null, appliedAt: new Date(), durationMs: null, ...fields };
            rows.push(row);
            return row;
        },
        reset: () => { rows.length = 0; },
        names: () => rows.map(row => row.name),
    };
}

module.exports = { fakeMigrationRecords };
