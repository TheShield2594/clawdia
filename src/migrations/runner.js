const fs = require('fs');
const path = require('path');
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

/**
 * Discovers and applies any pending migrations in this directory.
 * Migrations are .js files (excluding runner.js itself) sorted by filename.
 *
 * Each migration file must export `{ name: string, up: async function }`, and
 * may export:
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
 * Already-applied migrations are skipped (tracked in the MigrationRecord collection).
 */
async function runMigrations({ dir = __dirname } = {}) {
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.js') && f !== 'runner.js')
        .sort();

    if (files.length === 0) {
        console.log('[MIGRATIONS] No migration files found.');
        return;
    }

    const applied = new Set(
        (await MigrationRecord.find({}, 'name').lean()).map(r => r.name)
    );

    const baseTimeoutMs = envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;

    let count = 0;
    const deferred = [];
    for (const file of files) {
        const migration = require(path.join(dir, file));
        const { name, up } = migration;

        if (!name || typeof up !== 'function') {
            console.warn(`[MIGRATIONS] Skipping ${file}: must export { name, up }`);
            continue;
        }

        if (applied.has(name)) {
            console.log(`[MIGRATIONS] Already applied: ${name}`);
            continue;
        }

        const timeoutMs = resolveTimeoutMs(migration.timeoutMs, baseTimeoutMs);

        console.log(`[MIGRATIONS] Applying: ${name} (budget ${timeoutMs}ms)`);
        const start = Date.now();
        try {
            await withTimeout(up({ timeoutMs }), timeoutMs, name);
            const durationMs = Date.now() - start;
            await MigrationRecord.create({ name, durationMs });
            console.log(`[MIGRATIONS] Applied ${name} in ${durationMs}ms`);
            count++;
        } catch (err) {
            console.error(`[MIGRATIONS] FAILED: ${name}`, err);
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

module.exports = { runMigrations };
