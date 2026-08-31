'use strict';

// A couple of these run the claim's poll loop under fake timers, which is what
// Mongoose warns about on require.
process.env.SUPPRESS_JEST_WARNINGS = 'true';

/**
 * #654. The runner wrote a migration's MigrationRecord *after* running it, and
 * `name` is unique — so two processes starting together both ran the migration
 * and the loser threw E11000 out of `runMigrations`, aborting startup. The
 * failure was in the bookkeeping, not the migration: the schema change had
 * applied perfectly well, and the bot refused to boot on the way to writing
 * that down. Harmless while exactly one instance runs, and a deploy hazard the
 * moment there is a rolling update or a second replica.
 *
 * The record is now claimed before the migration runs, which turns that unique
 * index from the thing that broke startup into the lock that prevents the
 * double run. These cover the claim itself; the concurrency it exists for is
 * exercised against a real mongod in tests/integration/migrations.test.js,
 * because a duplicate key is a server decision and a mock only agrees to raise
 * one because it was told to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { fakeMigrationRecords } = require('./helpers/fakeMigrationRecords');

const mockRecords = fakeMigrationRecords();
jest.mock('../src/models/MigrationRecord', () => mockRecords.model);

const { claimMigration, runMigrations } = require('../src/migrations/runner');

const TIMEOUT_MS = 1_000;
const POLL_MS = 2_000;      // CLAIM_POLL_MS in the runner
const GRACE_MS = 60_000;    // STALE_CLAIM_GRACE_MS in the runner

let dir;

const writeMigration = (file, body) => fs.writeFileSync(path.join(dir, file), body);
const held = name => mockRecords.rows.find(row => row.name === name);

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-claim-'));
    mockRecords.reset();
    process.env.MIGRATION_BACKUP = 'skip';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.MIGRATION_BACKUP;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('claiming a migration', () => {
    it('takes an unheld one and marks it running, not applied', async () => {
        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toBe('claimed');

        expect(held('001_a').state).toBe('running');
        expect(held('001_a').startedAt).toBeInstanceOf(Date);
    });

    it('reports one that is already complete rather than running it again', async () => {
        mockRecords.seed({ name: '001_a', state: 'complete' });
        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toBe('applied');
    });

    // Records written before the claim existed have no state field at all, and
    // reading those as "still running" would block every boot after an upgrade.
    it('treats a record from before this field existed as applied', async () => {
        mockRecords.rows.push({ name: '001_a', appliedAt: new Date() });
        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toBe('applied');
    });

    it('waits on a live claim, then reports the result the holder wrote', async () => {
        jest.useFakeTimers();
        mockRecords.seed({ name: '001_a', state: 'running', startedAt: new Date() });

        const claim = claimMigration('001_a', TIMEOUT_MS);
        await jest.advanceTimersByTimeAsync(0);
        expect(held('001_a').state).toBe('running');

        // The holder finishes while this process is between polls.
        held('001_a').state = 'complete';
        await jest.advanceTimersByTimeAsync(POLL_MS);

        await expect(claim).resolves.toBe('applied');
    });

    it('claims it after all if the holder failed and released', async () => {
        jest.useFakeTimers();
        mockRecords.seed({ name: '001_a', state: 'running', startedAt: new Date() });

        const claim = claimMigration('001_a', TIMEOUT_MS);
        await jest.advanceTimersByTimeAsync(0);

        // What the runner's own failure path does: the migration threw, so the
        // claim goes and the record is left for the next boot to retry.
        mockRecords.reset();
        await jest.advanceTimersByTimeAsync(POLL_MS);

        await expect(claim).resolves.toBe('claimed');
        expect(held('001_a').state).toBe('running');
    });

    // A process killed mid-migration leaves its claim behind. Waiting on one
    // forever is a boot that never completes, so age is what breaks the tie.
    it('takes over a claim whose holder is long past its budget', async () => {
        const startedAt = new Date(Date.now() - (TIMEOUT_MS + GRACE_MS + 1_000));
        mockRecords.seed({ name: '001_a', state: 'running', startedAt });

        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toBe('claimed');

        // Restamped, so the next process to come along waits on this one
        // instead of taking the same claim over a second time.
        expect(held('001_a').startedAt.getTime()).toBeGreaterThan(startedAt.getTime());
        expect(console.warn.mock.calls.flat().join(' ')).toContain('Taking over the claim');
    });

    it('does not take over one that is merely slow', async () => {
        jest.useFakeTimers();
        // Past its own budget, inside the grace: the holder is still unwinding.
        const startedAt = new Date(Date.now() - (TIMEOUT_MS + 1_000));
        mockRecords.seed({ name: '001_a', state: 'running', startedAt });

        let settled = false;
        const claim = claimMigration('001_a', TIMEOUT_MS).then(result => { settled = true; return result; });
        await jest.advanceTimersByTimeAsync(POLL_MS * 2);

        expect(settled).toBe(false);
        expect(held('001_a').startedAt).toEqual(startedAt);

        held('001_a').state = 'complete';
        await jest.advanceTimersByTimeAsync(POLL_MS);
        await expect(claim).resolves.toBe('applied');
    });

    it('does not swallow an insert that failed for some other reason', async () => {
        const boom = Object.assign(new Error('not primary'), { code: 10107 });
        jest.spyOn(mockRecords.model, 'create').mockRejectedValueOnce(boom);

        await expect(claimMigration('001_a', TIMEOUT_MS)).rejects.toThrow('not primary');
    });
});

describe('the run that used to abort', () => {
    it('skips cleanly when the record appeared after the pending list was read', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() { throw new Error('should not run'); } };");

        // Exactly the race the issue describes: the applied-set read found
        // nothing, and by the time this process reached the claim another one
        // had applied and recorded it.
        jest.spyOn(mockRecords.model, 'find').mockReturnValueOnce({ lean: async () => [] });
        mockRecords.seed({ name: 'a', state: 'complete' });

        await expect(runMigrations({ dir })).resolves.toBeUndefined();
        expect(mockRecords.names()).toEqual(['a']);
    });

    it('completes the claim it took rather than inserting a second record', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {} };");

        await runMigrations({ dir });

        expect(mockRecords.rows).toHaveLength(1);
        expect(held('a').state).toBe('complete');
        expect(typeof held('a').durationMs).toBe('number');
    });

    it('releases the claim when the migration fails, so the next boot retries', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() { throw new Error('index build failed'); } };");

        await expect(runMigrations({ dir })).rejects.toThrow('index build failed');
        expect(mockRecords.rows).toEqual([]);
    });

    it('releases the claim when an optional migration fails too', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', optional: true, async up() { throw new Error('nope'); } };");

        await expect(runMigrations({ dir })).resolves.toBeUndefined();
        expect(mockRecords.rows).toEqual([]);
    });

    // waitForMigrations polls this; a claimed-but-unfinished record reading as
    // applied would let every other shard start against a half-migrated
    // database, which is the failure #732 exists to prevent.
    it('does not report a held claim as applied', async () => {
        writeMigration('001_a.js', "module.exports = { name: 'a', async up() {} };");
        mockRecords.seed({ name: 'a', state: 'running', startedAt: new Date() });

        const { pendingMigrationNames } = require('../src/migrations/runner');
        expect(await pendingMigrationNames({ dir })).toEqual(['a']);
    });
});
