const mongoose = require('mongoose');
const {
    encryptSecret, decryptSecret, isEncrypted, encryptionEnabled,
} = require('../config/secretBox');

/**
 * Encrypts the per-guild AI provider keys already sitting in the database.
 *
 * The Guild schema encrypts on write from now on (#564), but a setter only
 * fires on a value being written — every key saved before this deploy is still
 * plaintext in the document and in every nightly `mongodump`. The fix is only
 * worth anything once what is already stored is covered too, and an operator
 * should not have to re-enter four keys per guild to get there.
 *
 * A logged no-op when `SECRET_ENCRYPTION_KEY` is unset: encryption is opt-in
 * (see config/secretBox.js) and there is nothing to encrypt with. It records
 * itself as applied either way, because a migration that re-ran forever on the
 * installs that declined would be reporting a decision as an unfinished job.
 * An operator who sets the variable afterwards runs the same sweep on demand
 * with `npm run secrets:encrypt`, which is what the skip message says — that
 * script calls the exported helpers below rather than reimplementing them.
 *
 * The driver is used directly rather than the model. Reading through Mongoose
 * would re-run every validator on documents this has no business validating,
 * and would re-encrypt on the way out through the same schema setter — which
 * works, but hides where the encryption is happening.
 */

/** The Guild.ai paths holding a credential. */
const KEY_FIELDS = ['openaiKey', 'geminiKey', 'anthropicKey', 'openrouterKey'];

const anyKeySet = { $or: KEY_FIELDS.map(f => ({ [`ai.${f}`]: { $type: 'string', $ne: '' } })) };
const projection = KEY_FIELDS.reduce((p, f) => ({ ...p, [`ai.${f}`]: 1 }), { guildId: 1 });

const guildsWithKeys = () =>
    mongoose.connection.db.collection('guilds').find(anyKeySet, { projection });

const writeKeys = (id, $set) =>
    mongoose.connection.db.collection('guilds').updateOne({ _id: id }, { $set });

/**
 * Rewrites every plaintext guild AI key as ciphertext. Idempotent, so it is
 * safe to run at any time and safe to run twice.
 *
 * @returns {Promise<{ guilds: number, keys: number }>} what actually moved.
 * @throws if `SECRET_ENCRYPTION_KEY` is not configured — there is nothing to
 *         encrypt with, and silently doing nothing would read as success.
 */
async function encryptStoredGuildKeys() {
    if (!encryptionEnabled()) {
        throw new Error('SECRET_ENCRYPTION_KEY is not set, so there is no key to encrypt with.');
    }

    let guilds = 0;
    let keys = 0;

    for await (const doc of guildsWithKeys()) {
        const $set = {};
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (typeof value !== 'string' || value === '' || isEncrypted(value)) continue;
            $set[`ai.${field}`] = encryptSecret(value);
        }
        if (!Object.keys($set).length) continue;

        await writeKeys(doc._id, $set);
        guilds++;
        keys += Object.keys($set).length;
    }

    return { guilds, keys };
}

/**
 * The reverse, for `down()`: puts the keys back in the clear, which is the only
 * state code from before #564 can read.
 *
 * @throws if any stored value cannot be opened. Overwriting a credential with
 *         something that is not the credential destroys it, so a partial
 *         rollback must stop rather than guess.
 */
async function decryptStoredGuildKeys() {
    if (!encryptionEnabled()) {
        throw new Error('SECRET_ENCRYPTION_KEY is not set — the stored keys cannot be decrypted, ' +
            'and overwriting them would destroy them.');
    }

    let keys = 0;

    for await (const doc of guildsWithKeys()) {
        const $set = {};
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (!isEncrypted(value)) continue;
            const plain = decryptSecret(value);
            if (plain === null) {
                throw new Error(`Cannot decrypt ai.${field} for guild ${doc.guildId}.`);
            }
            $set[`ai.${field}`] = plain;
        }
        if (!Object.keys($set).length) continue;

        await writeKeys(doc._id, $set);
        keys += Object.keys($set).length;
    }

    return { keys };
}

/** How many stored keys are still in the clear. Never reads one into the log. */
async function countPlaintextGuildKeys() {
    let count = 0;
    for await (const doc of guildsWithKeys()) {
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (typeof value === 'string' && value !== '' && !isEncrypted(value)) count++;
        }
    }
    return count;
}

module.exports = {
    name: '018_encrypt_guild_ai_keys',

    async up() {
        if (!encryptionEnabled()) {
            const plaintext = await countPlaintextGuildKeys();
            console.log(
                `[MIGRATIONS] 018: SECRET_ENCRYPTION_KEY is not set — leaving ${plaintext} guild AI ` +
                'provider key(s) stored in the clear, which means database backups contain live ' +
                'credentials. To encrypt them later: set SECRET_ENCRYPTION_KEY (openssl rand -base64 32) ' +
                'and run `npm run secrets:encrypt`.'
            );
            return;
        }

        // The values themselves are never logged, only how many moved.
        const { guilds, keys } = await encryptStoredGuildKeys();
        console.log(`[MIGRATIONS] 018: encrypted ${keys} guild AI provider key(s) at rest across ${guilds} guild(s).`);
    },

    /**
     * Requires the same SECRET_ENCRYPTION_KEY; without it the sweep refuses
     * rather than overwriting live credentials with strings that are not them.
     */
    async down() {
        const { keys } = await decryptStoredGuildKeys();
        console.log(`[MIGRATIONS] 018: restored ${keys} guild AI provider key(s) to plaintext.`);
    },

    // Exported for scripts/encrypt-guild-secrets.js and the tests. The sweep
    // has one implementation, and this is it.
    encryptStoredGuildKeys,
    decryptStoredGuildKeys,
    countPlaintextGuildKeys,
    KEY_FIELDS,
};
