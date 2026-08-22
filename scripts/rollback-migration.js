#!/usr/bin/env node
'use strict';

// Rolls back one applied migration by name:
//
//   npm run migrate:rollback -- 013_split_guild_analytics
//
// Runs the migration's down() and deletes its MigrationRecord, so the next
// boot re-applies it — pair a rollback with deploying the code being rolled
// back to (or removing the migration file). Only the most recently applied
// migration can be rolled back; unwind further one invocation at a time.
// Irreversible migrations refuse here — restore the pre-migration backup
// instead (scripts/restore.sh).

require('dotenv').config();
// Resolves any <NAME>_FILE variable into <NAME>, so secrets can be mounted as
// files (docker secrets) instead of being readable via `docker inspect`. Runs
// straight after dotenv so .env can set the *_FILE paths too, and before
// anything reads process.env.
require('../src/config/fileSecrets').loadFileSecrets();

const mongoose = require('mongoose');
const { rollbackMigration } = require('../src/migrations/runner');

async function main() {
    const name = process.argv[2];
    if (!name) {
        console.error('Usage: npm run migrate:rollback -- <migration-name>');
        console.error('   or: node scripts/rollback-migration.js <migration-name>');
        process.exit(1);
    }

    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set (put it in .env or the environment).');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    try {
        await rollbackMigration(name);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
});
