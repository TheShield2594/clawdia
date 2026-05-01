const fs = require('fs');
const path = require('path');
const MigrationRecord = require('../models/MigrationRecord');

/**
 * Discovers and applies any pending migrations in this directory.
 * Migrations are .js files (excluding runner.js itself) sorted by filename.
 * Each migration file must export: { name: string, up: async function }.
 * Already-applied migrations are skipped (tracked in the MigrationRecord collection).
 */
async function runMigrations() {
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.js') && f !== 'runner.js')
        .sort();

    if (files.length === 0) {
        console.log('[MIGRATIONS] No migration files found.');
        return;
    }

    const applied = new Set(
        (await MigrationRecord.find({}, 'name').lean()).map(r => r.name)
    );

    let count = 0;
    for (const file of files) {
        const migration = require(path.join(migrationsDir, file));
        const { name, up } = migration;

        if (!name || typeof up !== 'function') {
            console.warn(`[MIGRATIONS] Skipping ${file}: must export { name, up }`);
            continue;
        }

        if (applied.has(name)) {
            console.log(`[MIGRATIONS] Already applied: ${name}`);
            continue;
        }

        console.log(`[MIGRATIONS] Applying: ${name}`);
        const start = Date.now();
        try {
            await up();
            const durationMs = Date.now() - start;
            await MigrationRecord.create({ name, durationMs });
            console.log(`[MIGRATIONS] Applied ${name} in ${durationMs}ms`);
            count++;
        } catch (err) {
            console.error(`[MIGRATIONS] FAILED: ${name}`, err);
            // Re-throw so startup aborts — running with a partially-applied schema is unsafe.
            throw err;
        }
    }

    if (count === 0) {
        console.log('[MIGRATIONS] All migrations already applied. Nothing to do.');
    } else {
        console.log(`[MIGRATIONS] Applied ${count} migration(s).`);
    }
}

module.exports = { runMigrations };
