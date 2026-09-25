const {
    encryptSecret, decryptSecret, isEncrypted, isBound, encryptionEnabled,
} = require('../config/secretBox');
const { KEY_FIELDS, compareAndSet, guildsWithKeys, bindingOf } = require('./018_encrypt_guild_ai_keys');

/**
 * Binds the stored guild AI provider keys to their guild and field (#1152).
 *
 * Migration 018 sealed the keys, but in a format that opens anywhere: anyone
 * who can write to the database could copy one guild's sealed key into
 * another guild's document, and the bot would spend it on the second guild's
 * behalf. The Guild schema now seals new writes with the guild and field as
 * GCM additional authenticated data (the `enc.v2.` format); this rewrites the
 * `enc.v1.` values already stored so they are bound too.
 *
 * Plaintext keys are left to 018 and `npm run secrets:encrypt`, which now seal
 * straight to the bound format. A logged no-op when `SECRET_ENCRYPTION_KEY` is
 * unset, for the same reason as 018: nothing is sealed, so nothing to bind.
 *
 * The driver directly, with the same compare-and-set as 018 — the helpers are
 * imported from it so there is one implementation of each.
 */

/**
 * Rewrites every unbound sealed key as a bound one. Idempotent.
 *
 * A value that will not open is left as it is and counted: overwriting it
 * would destroy a credential the operator may still be able to recover by
 * putting the right SECRET_ENCRYPTION_KEY back.
 *
 * @returns {Promise<{ keys: number, skipped: number, unreadable: number }>}
 */
async function bindStoredGuildKeys() {
    if (!encryptionEnabled()) {
        throw new Error('SECRET_ENCRYPTION_KEY is not set, so the stored keys cannot be opened to bind them.');
    }

    let keys = 0;
    let skipped = 0;
    let unreadable = 0;

    for await (const doc of guildsWithKeys()) {
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (!isEncrypted(value) || isBound(value)) continue;

            const plain = decryptSecret(value);
            if (plain === null) { unreadable++; continue; }

            if (await compareAndSet(doc._id, field, value, encryptSecret(plain, bindingOf(doc, field)))) keys++;
            else skipped++;
        }
    }

    return { keys, skipped, unreadable };
}

/**
 * The reverse, for `down()`: code from before #1152 cannot open a bound value,
 * so rolling back has to put the keys back in the unbound format first.
 *
 * An install with no bound keys — including every one that never set
 * SECRET_ENCRYPTION_KEY — has nothing to undo, and rolls back without it.
 *
 * @returns {Promise<{ keys: number, skipped: number }>}
 * @throws if a bound value cannot be opened, rather than overwrite it.
 */
async function unbindStoredGuildKeys() {
    let keys = 0;
    let skipped = 0;

    for await (const doc of guildsWithKeys()) {
        for (const field of KEY_FIELDS) {
            const value = doc.ai?.[field];
            if (!isBound(value)) continue;

            if (!encryptionEnabled()) {
                throw new Error('SECRET_ENCRYPTION_KEY is not set — the stored keys cannot be opened, ' +
                    'and overwriting them would destroy them.');
            }

            const plain = decryptSecret(value, bindingOf(doc, field));
            if (plain === null) {
                throw new Error(`Cannot decrypt ai.${field} for guild ${doc.guildId}.`);
            }
            if (await compareAndSet(doc._id, field, value, encryptSecret(plain))) keys++;
            else skipped++;
        }
    }

    return { keys, skipped };
}

module.exports = {
    name: '029_bind_guild_ai_keys',

    async up() {
        if (!encryptionEnabled()) {
            console.log('[MIGRATIONS] 029: SECRET_ENCRYPTION_KEY is not set — no sealed guild AI keys to bind.');
            return;
        }

        const { keys, skipped, unreadable } = await bindStoredGuildKeys();
        console.log(`[MIGRATIONS] 029: bound ${keys} guild AI provider key(s) to their guild and field.`);
        if (skipped) {
            console.warn(
                `[MIGRATIONS] 029: ${skipped} key(s) were rewritten by another process mid-sweep and ` +
                'left as they were found. Re-run `npm run secrets:encrypt` once that process has stopped.'
            );
        }
        if (unreadable) {
            console.warn(
                `[MIGRATIONS] 029: ${unreadable} key(s) could not be opened with the current ` +
                'SECRET_ENCRYPTION_KEY and were left as they were. Those guilds need to re-enter their key.'
            );
        }
    },

    async down() {
        const { keys, skipped } = await unbindStoredGuildKeys();
        console.log(`[MIGRATIONS] 029: unbound ${keys} guild AI provider key(s).`);
        if (skipped) {
            throw new Error(
                `[MIGRATIONS] 029 rollback is incomplete: ${skipped} key(s) were rewritten by another ` +
                'process mid-rollback and are still bound. Stop the bot and roll back again — an ' +
                'image from before #1152 cannot read them.'
            );
        }
    },

    bindStoredGuildKeys,
    unbindStoredGuildKeys,
};
