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

/**
 * Writes one key, but only if it still holds the value the cursor read.
 *
 * The expected value belongs in the filter because the sweep is not the only
 * writer. `npm run secrets:encrypt` is meant to be run against a live bot, and
 * a guild admin saving a key between the cursor read and the update would
 * otherwise have their new key silently replaced by the encrypted old one — a
 * server quietly reverted to the credential it stopped using.
 *
 * A mismatch is skipped rather than retried, because a mismatch means the value
 * was rewritten through the Guild schema setter, which encrypts. The new value
 * is already sealed, so leaving it alone is the correct outcome and not merely
 * the safe one. (The exception is a rolling deploy where a pre-#564 process is
 * still writing plaintext. That process cannot read sealed keys either, so a
 * mixed deploy is outside what this can guarantee; the sweep is idempotent, so
 * a re-run once the old process is gone picks up whatever it wrote.)
 *
 * @returns {Promise<boolean>} false when the document changed underneath us.
 */
async function compareAndSet(id, field, expected, value) {
    const result = await mongoose.connection.db.collection('guilds').updateOne(
        { _id: id, [`ai.${field}`]: expected },
        { $set: { [`ai.${field}`]: value } },
    );
    return result.matchedCount === 1;
}

/**
 * Rewrites every plaintext guild AI key as ciphertext. Idempotent, so it is
 * safe to run at any time and safe to run twice.
 *
 * @returns {Promise<{ guilds: number, keys: number, skipped: number }>} what
 *          moved, and how many keys were rewritten by someone else mid-sweep.
 * @throws if `SECRET_ENCRYPTION_KEY` is not configured — there is nothing to
 *         encrypt with, and silently doing nothing would read as success.
 */
async function encryptStoredGuildKeys() {
    if (!encryptionEnabled()) {
        throw new Error('SECRET_ENCRYPTION_KEY is not set, so there is no key to encrypt with.');
    }

    let guilds = 0;
    let keys = 0;
    let skipped = 0;

    for await (const doc of guildsWithKeys()) {
        let written = 0;
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (typeof value !== 'string' || value === '' || isEncrypted(value)) continue;

            // One update per field, not one per document: a document-wide
            // compare-and-set would let a single field changing underneath us
            // block the other three.
            if (await compareAndSet(doc._id, field, value, encryptSecret(value))) written++;
            else skipped++;
        }
        if (!written) continue;

        guilds++;
        keys += written;
    }

    return { guilds, keys, skipped };
}

/**
 * The reverse, for `down()`: puts the keys back in the clear, which is the only
 * state code from before #564 can read.
 *
 * @returns {Promise<{ keys: number, skipped: number }>} `skipped` counts keys
 *          rewritten by someone else mid-rollback, which are left sealed — so a
 *          non-zero count means the rollback is not complete and the bot should
 *          be stopped and the rollback re-run.
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
    let skipped = 0;

    for await (const doc of guildsWithKeys()) {
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (!isEncrypted(value)) continue;
            const plain = decryptSecret(value);
            if (plain === null) {
                throw new Error(`Cannot decrypt ai.${field} for guild ${doc.guildId}.`);
            }
            // Compare-and-set for the same reason as the forward sweep, and with
            // the same conclusion: a value that changed since the read was
            // written through the schema setter, so unsealing what we read would
            // put back a credential the guild has already replaced.
            if (await compareAndSet(doc._id, field, value, plain)) keys++;
            else skipped++;
        }
    }

    return { keys, skipped };
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
        const { guilds, keys, skipped } = await encryptStoredGuildKeys();
        console.log(`[MIGRATIONS] 018: encrypted ${keys} guild AI provider key(s) at rest across ${guilds} guild(s).`);
        // Migrations run before the dashboard is listening and before the
        // gateway login, so this should be zero here. If it is not, another
        // process is writing to the same database.
        if (skipped) {
            console.warn(
                `[MIGRATIONS] 018: ${skipped} key(s) were rewritten by another process mid-sweep and ` +
                'left as they were found. Re-run `npm run secrets:encrypt` once that process has stopped.'
            );
        }
    },

    /**
     * Requires the same SECRET_ENCRYPTION_KEY; without it the sweep refuses
     * rather than overwriting live credentials with strings that are not them.
     */
    async down() {
        const { keys, skipped } = await decryptStoredGuildKeys();
        console.log(`[MIGRATIONS] 018: restored ${keys} guild AI provider key(s) to plaintext.`);
        if (skipped) {
            throw new Error(
                `[MIGRATIONS] 018 rollback is incomplete: ${skipped} key(s) were rewritten by another ` +
                'process mid-rollback and are still encrypted. Stop the bot and roll back again — an ' +
                'image from before #564 cannot read them.'
            );
        }
    },

    // Exported for scripts/encrypt-guild-secrets.js and the tests. The sweep
    // has one implementation, and this is it.
    encryptStoredGuildKeys,
    decryptStoredGuildKeys,
    countPlaintextGuildKeys,
    KEY_FIELDS,
};
