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

/** Lets a promise chain the test just unblocked run to its end. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

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
    delete process.env.MIGRATION_TIMEOUT_MS;
    delete globalThis.__finishSlow;
    delete globalThis.__failSlow;
    delete globalThis.__finishA;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('claiming a migration', () => {
    it('takes an unheld one and marks it running, not applied', async () => {
        const { status, owner } = await claimMigration('001_a', TIMEOUT_MS);

        expect(status).toBe('claimed');
        expect(held('001_a').state).toBe('running');
        expect(held('001_a').startedAt).toBeInstanceOf(Date);
        // The token every later write on this claim has to present.
        expect(held('001_a').owner).toBe(owner);
        expect(typeof owner).toBe('string');
    });

    it('reports one that is already complete rather than running it again', async () => {
        mockRecords.seed({ name: '001_a', state: 'complete' });
        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toEqual({ status: 'applied', owner: null });
    });

    // Records written before the claim existed have no state field at all, and
    // reading those as "still running" would block every boot after an upgrade.
    it('treats a record from before this field existed as applied', async () => {
        mockRecords.rows.push({ name: '001_a', appliedAt: new Date() });
        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toEqual({ status: 'applied', owner: null });
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

        await expect(claim).resolves.toMatchObject({ status: 'applied' });
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

        await expect(claim).resolves.toMatchObject({ status: 'claimed' });
        expect(held('001_a').state).toBe('running');
    });

    // A process killed mid-migration leaves its claim behind. Waiting on one
    // forever is a boot that never completes, so age is what breaks the tie.
    it('takes over a claim whose holder is long past its budget', async () => {
        const startedAt = new Date(Date.now() - (TIMEOUT_MS + GRACE_MS + 1_000));
        mockRecords.seed({ name: '001_a', state: 'running', startedAt, owner: 'the-dead-one' });

        const { status, owner } = await claimMigration('001_a', TIMEOUT_MS);

        expect(status).toBe('claimed');
        // Restamped and re-owned, so the next process to come along waits on
        // this one instead of taking the same claim over a second time — and
        // the process that lost it can no longer write to the record.
        expect(held('001_a').startedAt.getTime()).toBeGreaterThan(startedAt.getTime());
        expect(held('001_a').owner).toBe(owner);
        expect(owner).not.toBe('the-dead-one');
        expect(console.warn.mock.calls.flat().join(' ')).toContain('Taking over the claim');
    });

    // A record written before `owner` existed has no such field, and Mongo
    // matches `{ owner: null }` against that — so an upgrade does not leave a
    // stale claim nobody is allowed to take over.
    it('takes over a stale claim from before the owner field existed', async () => {
        const startedAt = new Date(Date.now() - (TIMEOUT_MS + GRACE_MS + 1_000));
        mockRecords.rows.push({ name: '001_a', state: 'running', startedAt });

        await expect(claimMigration('001_a', TIMEOUT_MS)).resolves.toMatchObject({ status: 'claimed' });
        expect(held('001_a').owner).toEqual(expect.any(String));
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
        await expect(claim).resolves.toMatchObject({ status: 'applied' });
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

    // withTimeout stops *waiting*; it does not stop the migration, which goes on
    // running against the server. Releasing the claim at that moment would let
    // another process start the same migration alongside the one still running —
    // the exact concurrency the claim exists to prevent, reintroduced by its own
    // cleanup.
    it('holds the claim while a migration it timed out on is still running', async () => {
        process.env.MIGRATION_TIMEOUT_MS = '30';
        writeMigration('001_slow.js', `
            module.exports = {
                name: 'slow',
                up: () => new Promise(resolve => { globalThis.__finishSlow = resolve; }),
            };
        `);

        await expect(runMigrations({ dir })).rejects.toThrow(/Timed out after 30ms: slow/);

        // Still held, well past the budget it overran.
        expect(held('slow')).toMatchObject({ state: 'running' });
        expect(console.warn.mock.calls.flat().join(' ')).toContain('Holding the claim on slow');

        // And released once the work it could not wait for finally settles.
        globalThis.__finishSlow();
        await settle();
        expect(held('slow')).toBeUndefined();
    });

    it('releases the claim when the work it timed out on eventually fails', async () => {
        process.env.MIGRATION_TIMEOUT_MS = '30';
        writeMigration('001_slow.js', `
            module.exports = {
                name: 'slow',
                up: () => new Promise((resolve, reject) => { globalThis.__failSlow = reject; }),
            };
        `);

        await expect(runMigrations({ dir })).rejects.toThrow(/Timed out/);
        globalThis.__failSlow(new Error('index build refused'));
        await settle();

        expect(held('slow')).toBeUndefined();
    });

    it("does not delete the claim of the process that took over from it", async () => {
        process.env.MIGRATION_TIMEOUT_MS = '30';
        writeMigration('001_slow.js', `
            module.exports = {
                name: 'slow',
                up: () => new Promise(resolve => { globalThis.__finishSlow = resolve; }),
            };
        `);

        await expect(runMigrations({ dir })).rejects.toThrow(/Timed out/);
        const first = held('slow').owner;

        // The first runner's process is still alive but its claim has aged out,
        // so a second one takes it over and starts the migration again.
        held('slow').startedAt = new Date(Date.now() - (30 + GRACE_MS + 1_000));
        const { owner: second } = await claimMigration('slow', 30);
        expect(second).not.toBe(first);

        // Now the first runner's migration finally settles and tries to clean up
        // after itself. The record it would have deleted is no longer its own.
        globalThis.__finishSlow();
        await settle();

        expect(held('slow')).toMatchObject({ state: 'running', owner: second });
    });

    it("does not mark complete a claim that was taken over while it ran", async () => {
        writeMigration('001_a.js', `
            module.exports = {
                name: 'a',
                up: () => new Promise(resolve => { globalThis.__finishA = resolve; }),
            };
        `);

        const run = runMigrations({ dir });
        await settle();
        expect(held('a').state).toBe('running');

        // Taken over mid-run: another process now owns this record and is
        // running the migration itself.
        held('a').owner = 'the-successor';
        globalThis.__finishA();
        await run;

        // Marking it complete here would announce as applied a migration the
        // successor is still part-way through.
        expect(held('a')).toMatchObject({ state: 'running', owner: 'the-successor' });
        expect(console.warn.mock.calls.flat().join(' ')).toContain('claim had already');
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
