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

const { pendingMigrationNames, waitForMigrations, isRecordableMigration } = require('../src/migrations/runner');

let dir;

function writeMigration(file, name, extra = '') {
    fs.writeFileSync(
        path.join(dir, file),
        `module.exports = { name: ${JSON.stringify(name)}, up: async () => {}, down: async () => {}${extra} };\n`
    );
}

/** A file the runner skips outright: it never runs, so it is never recorded. */
function writeMalformedMigration(file, body) {
    fs.writeFileSync(path.join(dir, file), `module.exports = ${body};\n`);
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

    // ── What runMigrations will never record ─────────────────────────────────
    //
    // Both of these strand a non-primary shard: shard 0 boots fine, every other
    // shard waits the full timeout for a record that is never coming and then
    // refuses to start. The filter here has to agree with runMigrations' own.

    it('does not wait on a file that does not export a name and an up()', async () => {
        writeMigration('001_a.js', '001_a');
        writeMalformedMigration('002_no_up.js', '{ name: "002_no_up" }');
        writeMalformedMigration('003_no_name.js', '{ up: async () => {} }');
        records.push({ name: '001_a' });

        // runMigrations skips both with a warning and records neither.
        expect(await pendingMigrationNames({ dir })).toEqual([]);
    });

    it('does not wait on an optional migration', async () => {
        // An optional migration that fails is deliberately left unrecorded so
        // the next boot retries it. The bot is merely faster with one applied —
        // not a thing another shard should refuse to start over.
        writeMigration('001_a.js', '001_a');
        writeMigration('002_index.js', '002_index', ', optional: true');
        records.push({ name: '001_a' });

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

    it('does not strand a shard behind a migration that will never be recorded', async () => {
        // The end-to-end shape of the two cases above: shard 0 boots
        // successfully, and every other shard must boot too rather than sitting
        // out its timeout and exiting.
        writeMigration('001_a.js', '001_a');
        writeMalformedMigration('002_no_up.js', '{ name: "002_no_up" }');
        writeMigration('003_index.js', '003_index', ', optional: true');
        records.push({ name: '001_a' });

        await expect(waitForMigrations({ dir, timeoutMs: 40, pollMs: 5 })).resolves.toBe(true);
        expect(console.error).not.toHaveBeenCalled();
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

describe('isRecordableMigration agrees with what runMigrations records', () => {
    it('accepts a migration that will run and be recorded', () => {
        expect(isRecordableMigration({ name: 'a', up: async () => {} })).toBe(true);
    });

    it('rejects the shapes runMigrations runs without recording', () => {
        expect(isRecordableMigration({ name: 'a' })).toBe(false);                                  // no up()
        expect(isRecordableMigration({ up: async () => {} })).toBe(false);                          // no name
        expect(isRecordableMigration({ name: '', up: async () => {} })).toBe(false);                // empty name
        expect(isRecordableMigration({ name: 'a', up: async () => {}, optional: true })).toBe(false);
        expect(isRecordableMigration(null)).toBe(false);
        expect(isRecordableMigration(undefined)).toBe(false);
    });
});
