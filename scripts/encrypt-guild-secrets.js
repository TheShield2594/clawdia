#!/usr/bin/env node
'use strict';

// Encrypts the per-guild AI provider keys already stored in MongoDB (#564):
//
//   npm run secrets:encrypt
//
// Migration 018 does this on the boot after upgrading, but only for installs
// that already had SECRET_ENCRYPTION_KEY set at that point. This is the same
// sweep on demand, for an operator who turns encryption on afterwards. It is
// idempotent: keys already encrypted are left alone, so running it twice, or
// after adding a new guild's key, costs nothing.
//
// Stop the bot first is not required — the sweep only rewrites values the
// running bot reads through the same decryptSecret path either way.

require('dotenv').config();
// Resolves any <NAME>_FILE variable into <NAME>, so SECRET_ENCRYPTION_KEY can
// be a mounted docker secret rather than something `docker inspect` prints.
require('../src/config/fileSecrets').loadFileSecrets();

const mongoose = require('mongoose');
const { encryptStoredGuildKeys } = require('../src/migrations/018_encrypt_guild_ai_keys');
const { encryptionEnabled } = require('../src/config/secretBox');

async function main() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set (put it in .env or the environment).');
        process.exit(1);
    }
    if (!encryptionEnabled()) {
        console.error(
            'SECRET_ENCRYPTION_KEY is not set, so there is nothing to encrypt with.\n' +
            'Generate one with `openssl rand -base64 32`, put it in .env, and make sure the bot ' +
            'runs with the same value — without it the encrypted keys cannot be read back.'
        );
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    try {
        const { guilds, keys } = await encryptStoredGuildKeys();
        console.log(keys
            ? `Encrypted ${keys} guild AI provider key(s) across ${guilds} guild(s).`
            : 'Nothing to do — every stored guild AI provider key is already encrypted.');
    } finally {
        await mongoose.disconnect();
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
});
