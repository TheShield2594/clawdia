#!/usr/bin/env node
'use strict';

// Erases a member's data for requests that arrive by email rather than in
// Discord (#1013). It is the operator-side twin of `/mydata delete` and the
// dashboard's delete button: all three call src/utils/userDataRegistry.js, so
// there is one definition of what erasure removes, what it keeps, and how the
// removed balances are written back to the guild ledger.
//
//   node scripts/delete-user-data.js <userId>                 # preview, delete nothing
//   node scripts/delete-user-data.js <userId> --guild <id>    # scope to one guild
//   node scripts/delete-user-data.js <userId> --yes           # actually delete
//
// A preview by default, on purpose. Deletion cannot be undone, and shell access
// to the host is the same bar as `npm run migrate:rollback` — a hand on the
// wheel for the operations no other path can put back. The run prints what it
// would touch and refuses to touch it until `--yes` says so.
//
// With no `--guild`, it acts across every guild the member has any registered
// data in — economy profile or not. A request to be forgotten is rarely scoped
// to one server, and the member id is the same everywhere.

require('dotenv').config();
require('../src/config/fileSecrets').loadFileSecrets();

const mongoose = require('mongoose');
const { exportUserData, deleteUserData, guildIdsForUser } = require('../src/utils/userDataRegistry');

function parseArgs(argv) {
    const args = { userId: null, guildId: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--yes' || arg === '-y') args.apply = true;
        else if (arg === '--guild') args.guildId = argv[++i] || null;
        else if (!arg.startsWith('-') && !args.userId) args.userId = arg;
    }
    return args;
}

/** Every guild the member has any registered data in, or just the one asked for. */
async function guildsFor(userId, guildId) {
    if (guildId) return [guildId];
    // Discovered across every registered collection, not just the economy
    // profile: a member can have a reminder, a case, or a syndicate membership
    // in a guild they never earned a coin in (#1013 review).
    return guildIdsForUser(userId);
}

/** A one-line count of what the member has in a guild, for the preview. */
async function previewGuild(userId, guildId) {
    const dump = await exportUserData(userId, guildId);
    const parts = [];
    for (const [key, col] of Object.entries(dump.collections)) {
        const n = col.records.length;
        if (n > 0) parts.push(`${key}=${n}${col.retained ? ' (kept)' : ''}`);
    }
    return parts.length ? parts.join(', ') : 'no stored records';
}

async function main() {
    const { userId, guildId, apply } = parseArgs(process.argv.slice(2));

    if (!userId || !/^\d{17,20}$/.test(userId)) {
        console.error('Usage: node scripts/delete-user-data.js <userId> [--guild <id>] [--yes]');
        console.error('  <userId> must be a Discord user id.');
        process.exit(1);
    }

    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set (put it in .env or the environment).');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    try {
        const guilds = await guildsFor(userId, guildId);
        if (guilds.length === 0) {
            console.log(`No stored data found for ${userId}${guildId ? ` in guild ${guildId}` : ''}.`);
            return;
        }

        console.log(`User ${userId} — ${guilds.length} guild(s):\n`);
        for (const gid of guilds) {
            console.log(`  ${gid}: ${await previewGuild(userId, gid)}`);
        }

        if (!apply) {
            console.log('\nNothing was deleted. Re-run with --yes to erase the data above.');
            return;
        }

        console.log('');
        for (const gid of guilds) {
            const report = await deleteUserData(userId, gid);
            const removed = report.results.filter(r => r.behavior === 'delete').reduce((n, r) => n + r.changed, 0);
            const kept = report.results.filter(r => r.behavior !== 'delete' && r.changed > 0).length;
            console.log(
                `  erased ${gid}: ${removed} record group(s) deleted, ${kept} pseudonymised, ` +
                `${report.coinsRemoved.toLocaleString()} coins recorded in the ledger`
            );
        }
        console.log(`\nDone. Erased ${userId} across ${guilds.length} guild(s).`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
});
