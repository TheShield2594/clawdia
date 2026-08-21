'use strict';

// Under sharding only shard 0 runs migrations (#732). The other shards must not
// run their own — concurrent runs of the same migration is a different failure
// every time — and must not start serving traffic against a half-migrated
// database either. So they wait for the records shard 0 writes, and these cover
// the waiting.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const records = [];
jest.mock('../src/models/MigrationRecord', () => ({
    find: (filter = {}) => ({
        lean: async () => {
            const wanted = filter?.name?.$in;
            return records
                .filter(r => !wanted || wanted.includes(r.name))
                .map(r => ({ name: r.name }));
        },
    }),
    create: async doc => { records.push(doc); return doc; },
}));

const { pendingMigrationNames, waitForMigrations } = require('../src/migrations/runner');

let dir;

function writeMigration(file, name) {
    fs.writeFileSync(path.join(dir, file), `module.exports = { name: ${JSON.stringify(name)}, up: async () => {}, down: async () => {} };\n`);
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-wait-'));
    records.length = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('pendingMigrationNames', () => {
    it('reports what is on disk but not yet recorded', async () => {
        writeMigration('001_a.js', '001_a');
        writeMigration('002_b.js', '002_b');
        expect(await pendingMigrationNames({ dir })).toEqual(['001_a', '002_b']);

        records.push({ name: '001_a' });
        expect(await pendingMigrationNames({ dir })).toEqual(['002_b']);

        records.push({ name: '002_b' });
        expect(await pendingMigrationNames({ dir })).toEqual([]);
    });

    it('reports nothing when there are no migrations to run', async () => {
        expect(await pendingMigrationNames({ dir })).toEqual([]);
    });

    it('ignores a record for a migration that is not on this disk', async () => {
        // A rolled-back deploy can leave records for files this build does not
        // carry; that is not something to wait for.
        writeMigration('001_a.js', '001_a');
        records.push({ name: '001_a' }, { name: '999_from_the_future' });
        expect(await pendingMigrationNames({ dir })).toEqual([]);
    });
});

describe('waitForMigrations', () => {
    it('returns immediately when everything is already applied', async () => {
        writeMigration('001_a.js', '001_a');
        records.push({ name: '001_a' });
        await expect(waitForMigrations({ dir, timeoutMs: 50, pollMs: 5 })).resolves.toBe(true);
    });

    it('waits, and returns true once the primary shard records the migration', async () => {
        writeMigration('001_a.js', '001_a');
        // Stands in for shard 0 finishing partway through the wait.
        setTimeout(() => records.push({ name: '001_a' }), 20);
        await expect(waitForMigrations({ dir, timeoutMs: 2_000, pollMs: 5 })).resolves.toBe(true);
    });

    it('gives up rather than blocking a boot forever', async () => {
        // A migration that never lands is an operator problem, and a shard stuck
        // silently in a poll loop is a worse way to find out about it.
        writeMigration('001_a.js', '001_a');
        await expect(waitForMigrations({ dir, timeoutMs: 40, pollMs: 5 })).resolves.toBe(false);
        expect(console.error).toHaveBeenCalled();
    });

    it('reports failure rather than looping when the database cannot be read', async () => {
        writeMigration('001_a.js', '001_a');
        const MigrationRecord = require('../src/models/MigrationRecord');
        const original = MigrationRecord.find;
        MigrationRecord.find = () => ({ lean: async () => { throw new Error('no connection'); } });
        try {
            await expect(waitForMigrations({ dir, timeoutMs: 5_000, pollMs: 5 })).resolves.toBe(false);
        } finally {
            MigrationRecord.find = original;
        }
    });
});
