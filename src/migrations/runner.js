const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const MigrationRecord = require('../models/MigrationRecord');

// Wall-clock budget for a single migration. A migration that hangs holds the
// boot open for as long as it hangs, so there has to be a ceiling — but 30 s
// was a figure picked against a development database, and 005 rewrites the
// whole users collection. On a large install that figure is a boot loop:
// startup aborts, the supervisor restarts, the same migration runs out of
// budget again, forever. MIGRATION_TIMEOUT_MS is the way out of one without
// shipping a code change to a bot that will not start.
const DEFAULT_TIMEOUT_MS = 30_000;

// Reads the operator's override. A malformed value is ignored rather than
// treated as zero, which would time every migration out instantly.
function envTimeoutMs() {
    const raw = process.env.MIGRATION_TIMEOUT_MS;
    if (raw === undefined || String(raw).trim() === '') return null;

    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) {
        console.warn(
            `[MIGRATIONS] Ignoring MIGRATION_TIMEOUT_MS="${raw}": expected a positive number of milliseconds.`
        );
        return null;
    }
    return ms;
}

// A migration that exports `timeoutMs` is saying it is heavier than the
// default. An operator who raises MIGRATION_TIMEOUT_MS is asking for more
// headroom everywhere, so the larger of the two wins: if the declared value
// took precedence outright, the env var would be powerless against exactly the
// migration that is timing out.
function resolveTimeoutMs(declared, base) {
    if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return base;
    return Math.max(declared, base);
}

// Stops *waiting* after `ms`. It does not cancel the underlying work: the
// server-side operation carries on unless the migration bounded it itself,
// which is why `up()` is handed the budget it is running under and migrations
// that issue long queries pass it as maxTimeMS.
function withTimeout(promise, ms, label) {
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(
            () => reject(new Error(`[MIGRATIONS] Timed out after ${ms}ms: ${label}`)),
            ms
        ).unref();
    });
    // Clear the timer whichever promise wins so the callback never fires unnecessarily.
    return Promise.race([
        promise.then(
            v => { clearTimeout(timerId); return v; },
            e => { clearTimeout(timerId); return Promise.reject(e); }
        ),
        timeoutPromise
    ]);
}

// How long past a migration's own budget a claim is trusted before another
// process treats its holder as dead and takes it over. The holder gives up on
// its own after `timeoutMs` and deletes the claim, so this only ever elapses
// for a process that died without unwinding — a SIGKILL, a lost container, an
// OOM. Generous, because taking a live claim over means running the migration
// twice concurrently, which is the thing the claim exists to prevent.
const STALE_CLAIM_GRACE_MS = 60_000;

// How often a process that lost the claim re-checks. Same cadence as
// waitForMigrations, and for the same reason: the wait is measured in whole
// migrations, so a tighter poll only costs queries.
const CLAIM_POLL_MS = 2_000;

/**
 * True for the duplicate-key error a losing `create` gets on `name`.
 *
 * Mongoose surfaces the driver's error as-is on `create`, but a write wrapped
 * in a transaction or a bulk op can arrive with the driver error underneath, so
 * both shapes are checked.
 */
function isDuplicateKey(err) {
    return err?.code === 11000 || err?.cause?.code === 11000 || err?.writeErrors?.[0]?.code === 11000;
}

/**
 * Migration names already recorded as *finished*.
 *
 * A claimed-but-unfinished row is deliberately not in here: its migration has
 * not run yet, and treating it as applied is how a second process skips work
 * that never happened.
 */
async function appliedNames(filter = {}) {
    const records = await MigrationRecord
        .find({ ...filter, state: { $ne: 'running' } }, 'name')
        .lean();
    return new Set(records.map(r => r.name));
}

/**
 * Takes the exclusive right to run `name`, or reports that someone else already
 * has (#654).
 *
 * The record is inserted before the migration runs rather than after it, so the
 * unique index on `name` is the lock. Without one, a rolling update or a second
 * replica ran the same migration twice and the loser aborted startup on an
 * E11000 from the *bookkeeping* — a migration that had applied perfectly well
 * taking the bot down on the way to writing that it had.
 *
 * @returns {Promise<'claimed'|'applied'>} 'claimed' if this process should run
 *   the migration and complete the record; 'applied' if it is already done.
 */
async function claimMigration(name, timeoutMs) {
    let waiting = false;

    for (;;) {
        try {
            await MigrationRecord.create({ name, state: 'running', startedAt: new Date() });
            return 'claimed';
        } catch (err) {
            if (!isDuplicateKey(err)) throw err;
        }

        const existing = await MigrationRecord.findOne({ name }).lean();
        // Gone between the insert and the read: the holder failed and cleaned
        // up after itself, so this process is free to try for the claim.
        if (!existing) continue;
        if (existing.state !== 'running') return 'applied';

        const heldFor = Date.now() - new Date(existing.startedAt ?? existing.appliedAt ?? 0).getTime();
        if (heldFor >= timeoutMs + STALE_CLAIM_GRACE_MS) {
            // Only one taker wins: the update matches on the startedAt that was
            // read, so a second process racing for the same stale claim finds
            // it already moved and goes round again.
            const taken = await MigrationRecord.findOneAndUpdate(
                { name, state: 'running', startedAt: existing.startedAt },
                { $set: { startedAt: new Date() } },
            );
            if (taken) {
                console.warn(
                    `[MIGRATIONS] Taking over the claim on ${name}: held for ` +
                    `${Math.round(heldFor / 1000)}s without completing, so the process that ` +
                    'took it is presumed gone.'
                );
                return 'claimed';
            }
            continue;
        }

        if (!waiting) {
            console.log(`[MIGRATIONS] ${name} is being applied by another process — waiting.`);
            waiting = true;
        }
        await new Promise(resolve => setTimeout(resolve, CLAIM_POLL_MS).unref());
    }
}

// Discovers migration files and requires them, in apply order.
function loadMigrations(dir) {
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.js') && f !== 'runner.js')
        .sort()
        .map(file => ({ file, migration: require(path.join(dir, file)) }));
}

/**
 * A mongodump taken immediately before irreversible migrations run, because
 * afterwards it is the only way back: the runner rolls migrations back through
 * their `down()`, and an irreversible migration by definition has none.
 *
 * Controlled by MIGRATION_BACKUP:
 *   'skip'     don't attempt one
 *   'require'  a failed or impossible backup aborts startup rather than
 *              letting the destructive step run unprotected
 *   unset      attempt it; if mongodump is missing or fails, warn loudly and
 *              carry on, because a bot that cannot boot without a tool its
 *              container may not ship is a worse default than no backup —
 *              operators who want the guarantee set 'require'.
 *
 * The archive lands in MIGRATION_BACKUP_DIR (default ./backups, same place as
 * scripts/backup.sh) and is restored with scripts/restore.sh.
 */
function preMigrationBackup(irreversibleNames) {
    const mode = String(process.env.MIGRATION_BACKUP || '').toLowerCase();
    if (mode === 'skip') {
        console.warn('[MIGRATIONS] MIGRATION_BACKUP=skip — applying irreversible migrations without a backup.');
        return;
    }

    const fail = message => {
        if (mode === 'require') {
            throw new Error(`[MIGRATIONS] ${message} (MIGRATION_BACKUP=require, so refusing to run: ${irreversibleNames.join(', ')})`);
        }
        console.warn(
            `[MIGRATIONS] ${message} — continuing WITHOUT a backup before irreversible ` +
            `migration(s): ${irreversibleNames.join(', ')}. Run scripts/backup.sh first, ` +
            'or set MIGRATION_BACKUP=require to make this abort instead.'
        );
    };

    const uri = process.env.MONGODB_URI;
    if (!uri) return fail('MONGODB_URI is not set, cannot take a pre-migration backup');

    const backupDir = process.env.MIGRATION_BACKUP_DIR || path.join(process.cwd(), 'backups');
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
    const archive = path.join(backupDir, `pre-migration-${stamp}.gz`);

    try {
        fs.mkdirSync(backupDir, { recursive: true });
    } catch (err) {
        return fail(`could not create backup directory ${backupDir}: ${err.message}`);
    }

    console.log(`[MIGRATIONS] Taking pre-migration backup → ${archive}`);
    // Synchronous on purpose: this runs at boot before anything is served, and
    // the destructive migration must not start until the dump has finished.
    const result = spawnSync('mongodump', [`--uri=${uri}`, '--gzip', `--archive=${archive}`], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    if (result.error) {
        return fail(`mongodump could not be run (${result.error.code === 'ENOENT' ? 'not on PATH' : result.error.message})`);
    }
    if (result.status !== 0) {
        return fail(`mongodump exited with status ${result.status}`);
    }
    console.log('[MIGRATIONS] Pre-migration backup complete.');
}

/**
 * Discovers and applies any pending migrations in this directory.
 * Migrations are .js files (excluding runner.js itself) sorted by filename.
 *
 * Each migration file must export `{ name: string, up: async function }`, plus
 * a rollback story — one of:
 *
 *   down          async function that undoes `up`. Invoked only by
 *                 rollbackMigration (a boot never rolls back on its own),
 *                 under the same timeout machinery as `up`.
 *   irreversible  `true` for a migration whose effect cannot be computed back
 *                 (dropped fields, merged data). Declaring it is what triggers
 *                 the pre-migration backup, which is then the only way back.
 *
 * tests/migrationRollback.test.js enforces that every shipped migration
 * declares one of the two; the runner itself only warns, so a boot is never
 * blocked over a missing annotation.
 *
 * A migration may also export:
 *
 *   timeoutMs  Wall-clock budget for this migration, when the default is too
 *              tight for the work it does. `up({ timeoutMs })` receives the
 *              budget actually in force so it can bound its own queries.
 *   optional   `true` for a migration whose failure should not stop the bot
 *              booting — a performance index, not a schema change. It is left
 *              unrecorded so the next boot retries it, so only mark a
 *              migration optional when running it again later, out of order,
 *              is harmless.
 *
 * Already-applied migrations are skipped (tracked in the MigrationRecord
 * collection). Each record is written in two halves: claimed before the
 * migration runs, completed after it returns. That claim is the lock — a second
 * process starting at the same time loses the insert on the unique `name` and
 * waits for the result instead of applying the migration a second time (#654).
 * A migration that fails releases its claim and stays unrecorded, so the next
 * boot retries it exactly as before.
 */
async function runMigrations({ dir = __dirname } = {}) {
    const loaded = loadMigrations(dir);

    if (loaded.length === 0) {
        console.log('[MIGRATIONS] No migration files found.');
        return;
    }

    const applied = await appliedNames();

    const baseTimeoutMs = envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;

    const pending = [];
    for (const { file, migration } of loaded) {
        const { name, up } = migration;

        if (!name || typeof up !== 'function') {
            console.warn(`[MIGRATIONS] Skipping ${file}: must export { name, up }`);
            continue;
        }

        if (applied.has(name)) {
            console.log(`[MIGRATIONS] Already applied: ${name}`);
            continue;
        }

        if (typeof migration.down !== 'function' && migration.irreversible !== true) {
            console.warn(
                `[MIGRATIONS] ${name} declares no rollback story: export down() or ` +
                'irreversible: true. Treating it as irreversible.'
            );
        }

        pending.push(migration);
    }

    // Anything without a down() cannot be unwound once it runs, so this is the
    // last moment a copy of the data can be taken.
    const irreversible = pending.filter(m => typeof m.down !== 'function').map(m => m.name);
    if (irreversible.length > 0) {
        preMigrationBackup(irreversible);
    }

    let count = 0;
    const deferred = [];
    for (const migration of pending) {
        const { name, up } = migration;
        const timeoutMs = resolveTimeoutMs(migration.timeoutMs, baseTimeoutMs);

        // Claimed before it runs, so a second process racing this one waits for
        // the result instead of running the migration again and aborting
        // startup on the duplicate key its own bookkeeping would raise (#654).
        if (await claimMigration(name, timeoutMs) === 'applied') {
            console.log(`[MIGRATIONS] Applied elsewhere while waiting: ${name}`);
            continue;
        }

        console.log(`[MIGRATIONS] Applying: ${name} (budget ${timeoutMs}ms)`);
        const start = Date.now();
        try {
            await withTimeout(up({ timeoutMs }), timeoutMs, name);
            const durationMs = Date.now() - start;
            await MigrationRecord.updateOne(
                { name },
                { $set: { state: 'complete', durationMs, appliedAt: new Date() } },
            );
            console.log(`[MIGRATIONS] Applied ${name} in ${durationMs}ms`);
            count++;
        } catch (err) {
            console.error(`[MIGRATIONS] FAILED: ${name}`, err);
            // Release the claim. Nothing is recorded for a migration that did
            // not finish — the next boot retries it, as it always has — and a
            // claim left behind would block that boot until it went stale.
            await MigrationRecord.deleteOne({ name, state: 'running' })
                .catch(e => console.error(`[MIGRATIONS] Could not release the claim on ${name}:`, e.message));
            if (!migration.optional) {
                // Re-throw so startup aborts — running with a partially-applied schema is unsafe.
                throw err;
            }
            // An optional migration builds an index the bot is merely faster
            // with. Refusing to boot over one trades a slow bot for no bot.
            // Deliberately not recorded, so the next boot tries again.
            console.warn(
                `[MIGRATIONS] ${name} is optional — continuing startup without it. ` +
                'It stays unapplied and will be retried on the next boot. ' +
                'If it keeps timing out, raise MIGRATION_TIMEOUT_MS.'
            );
            deferred.push(name);
        }
    }

    if (count === 0) {
        console.log('[MIGRATIONS] All migrations already applied. Nothing to do.');
    } else {
        console.log(`[MIGRATIONS] Applied ${count} migration(s).`);
    }
    if (deferred.length > 0) {
        console.warn(`[MIGRATIONS] Deferred ${deferred.length} optional migration(s): ${deferred.join(', ')}`);
    }
}

/**
 * Rolls back one applied migration by running its `down()` and deleting its
 * MigrationRecord — after which the next boot re-applies it, so pair a
 * rollback with deploying the code you are rolling back to (or removing the
 * migration file).
 *
 * Never called at boot; the entry point is `npm run migrate:rollback -- <name>`
 * (scripts/rollback-migration.js). Only the most recently applied migration
 * can be rolled back: later migrations may build on what an earlier one wrote,
 * so the chain unwinds in reverse order, one step per invocation.
 *
 * A migration marked `irreversible` (or missing `down()`) refuses here by
 * design — the way back from those is the pre-migration backup, via
 * scripts/restore.sh.
 */
async function rollbackMigration(name, { dir = __dirname } = {}) {
    if (!name) {
        throw new Error('[MIGRATIONS] rollbackMigration needs a migration name.');
    }

    const loaded = loadMigrations(dir).filter(({ migration }) =>
        migration.name && typeof migration.up === 'function');

    const target = loaded.find(({ migration }) => migration.name === name);
    if (!target) {
        throw new Error(`[MIGRATIONS] No migration named "${name}" found in ${dir}.`);
    }

    const applied = await appliedNames();
    if (!applied.has(name)) {
        throw new Error(`[MIGRATIONS] ${name} is not recorded as applied — nothing to roll back.`);
    }

    const appliedInOrder = loaded
        .map(({ migration }) => migration.name)
        .filter(n => applied.has(n));
    const latest = appliedInOrder[appliedInOrder.length - 1];
    if (name !== latest) {
        throw new Error(
            `[MIGRATIONS] ${name} is not the most recently applied migration — ` +
            `roll back ${latest} first. Migrations unwind in reverse order.`
        );
    }

    const { migration } = target;
    if (typeof migration.down !== 'function') {
        throw new Error(
            `[MIGRATIONS] ${name} is irreversible: it defines no down(). ` +
            'Restore the pre-migration backup instead — see scripts/restore.sh.'
        );
    }

    const timeoutMs = resolveTimeoutMs(migration.timeoutMs, envTimeoutMs() ?? DEFAULT_TIMEOUT_MS);

    console.log(`[MIGRATIONS] Rolling back: ${name} (budget ${timeoutMs}ms)`);
    const start = Date.now();
    await withTimeout(migration.down({ timeoutMs }), timeoutMs, `${name} (down)`);
    await MigrationRecord.deleteOne({ name });
    console.log(
        `[MIGRATIONS] Rolled back ${name} in ${Date.now() - start}ms. ` +
        'It is no longer recorded as applied, so the next boot will re-apply it ' +
        'unless the file is removed with the code being rolled back to.'
    );
}

/**
 * True for a migration `runMigrations` will actually apply *and record*.
 *
 * This has to agree with runMigrations' own filtering exactly, because
 * waitForMigrations blocks on the answer. Two shapes run and leave no record,
 * and counting either as pending strands every non-primary shard on a
 * successful boot until it times out and refuses to start:
 *
 *   - A file that does not export both a name and an `up` function is skipped
 *     with a warning and never recorded.
 *   - An `optional` migration that fails is deliberately not recorded, so the
 *     next boot retries it. The bot is merely faster with one applied, which is
 *     the whole reason it is allowed to fail — so it is not something another
 *     shard should refuse to start over.
 */
function isRecordableMigration(migration) {
    const name = migration?.name;
    if (typeof name !== 'string' || name.length === 0) return false;
    if (typeof migration.up !== 'function') return false;
    if (migration.optional) return false;
    return true;
}

/**
 * Migration names that are discovered on disk but not yet recorded as applied.
 *
 * Split out of runMigrations so a process that must NOT run migrations can
 * still tell whether they have finished — which is what every shard but the
 * primary one needs (#732).
 */
async function pendingMigrationNames({ dir = __dirname } = {}) {
    const declared = loadMigrations(dir)
        .filter(({ migration }) => isRecordableMigration(migration))
        .map(({ migration }) => migration.name);
    if (declared.length === 0) return [];

    const applied = await appliedNames({ name: { $in: declared } });
    return declared.filter(name => !applied.has(name));
}

/**
 * Blocks until every discovered migration is recorded as applied.
 *
 * Only shard 0 runs migrations; the others must not start serving traffic
 * against a half-migrated database, and they cannot simply run their own —
 * concurrent runs of the same migration is a different failure every time. So
 * they wait for the records shard 0 writes.
 *
 * Gives up after `timeoutMs` and says so rather than blocking a boot forever: a
 * migration that never completes is an operator problem, and a shard stuck
 * silently in a poll loop is a worse way to find out about it.
 *
 * @returns {Promise<boolean>} true if everything applied, false on timeout.
 */
async function waitForMigrations({ dir = __dirname, timeoutMs = 300_000, pollMs = 2_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let announced = false;

    for (;;) {
        let pending;
        try {
            pending = await pendingMigrationNames({ dir });
        } catch (err) {
            console.error('[MIGRATIONS] Could not check migration state while waiting:', err.message);
            return false;
        }
        if (pending.length === 0) return true;

        if (!announced) {
            console.log(`[MIGRATIONS] Waiting for ${pending.length} migration(s) to be applied elsewhere: ${pending.join(', ')}`);
            announced = true;
        }
        if (Date.now() >= deadline) {
            console.error(`[MIGRATIONS] Gave up after ${Math.round(timeoutMs / 1000)}s waiting for: ${pending.join(', ')}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, pollMs).unref());
    }
}

module.exports = {
    runMigrations,
    claimMigration,
    rollbackMigration,
    pendingMigrationNames,
    waitForMigrations,
    isRecordableMigration,
};
