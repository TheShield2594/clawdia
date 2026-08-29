'use strict';

/**
 * Authenticated encryption for the credentials the bot stores in MongoDB.
 *
 * The per-guild AI provider keys (`guild.ai.openaiKey` and friends) are live
 * credentials that bill someone's account, and they were plain strings in the
 * database (#564). Reading them takes database access — but the compose stack
 * takes a `mongodump` every night into a host bind mount, unencrypted, and
 * keeps a month of them. So "needs database access" quietly meant "needs read
 * access to ./backups", which is a much lower bar and one an operator is
 * unlikely to have thought about when they set the directory up.
 *
 * AES-256-GCM with a random 96-bit IV per value. GCM rather than CBC because
 * the tag makes tampering detectable: a modified ciphertext fails to open
 * instead of decrypting to a different key.
 *
 * ── Opt-in, deliberately ───────────────────────────────────────────────────
 * With no `SECRET_ENCRYPTION_KEY` set, `encryptSecret` stores the value as it
 * always did. The alternative — refusing to start, or refusing to save a key —
 * would break every existing install on upgrade to fix a low-severity issue,
 * and an operator who runs the bot and its database on one machine they own
 * may reasonably decide the key buys them little. What must not happen is that
 * choice being made silently, so migration 018 says on the log which way an
 * install is configured, and the trade-off is written up in docs/SETUP_GUIDE.md.
 *
 * Whichever way it is configured, reads work: a stored value carries a version
 * prefix when it is encrypted, and anything without one is a plaintext key
 * written before the key existed. Turning encryption on is therefore just
 * setting the variable — migration 018 rewrites what is already stored on the
 * next boot, and `npm run secrets:encrypt` runs that same sweep on demand for
 * an operator who sets the variable after the migration has already run.
 */

const crypto = require('crypto');

/** Marks a stored value as ciphertext, and says which format it is in. */
const PREFIX = 'enc.v1.';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Domain separation for the KDF, not a secret. A per-value salt would have to
 * be stored next to every value and re-derived on every read; the passphrase
 * here is a machine-generated 32-byte secret rather than a human password, so
 * the work factor is guarding against nothing a fixed salt weakens.
 */
const KDF_SALT = Buffer.from('clawdia/secretBox/v1');

let cached = null; // { source: string, key: Buffer }

/**
 * The 32-byte key, or null when the operator has not configured one.
 *
 * Any passphrase is accepted and stretched with scrypt, so an operator is not
 * required to produce exactly 32 bytes of base64 — but a short one is a short
 * one, and the README asks for `openssl rand -base64 32`.
 */
function encryptionKey() {
    const source = process.env.SECRET_ENCRYPTION_KEY;
    if (!source || !source.trim()) {
        cached = null;
        return null;
    }
    if (cached?.source === source) return cached.key;

    const key = crypto.scryptSync(source, KDF_SALT, 32);
    cached = { source, key };
    return key;
}

/** Whether stored secrets are being encrypted at all. */
function encryptionEnabled() {
    return encryptionKey() !== null;
}

/** Whether a stored value is one of ours, rather than a plaintext credential. */
function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypts a secret for storage.
 *
 * Returns the input unchanged for anything that is not a non-empty string
 * (null, '', a value some caller has already encrypted), so it is safe as a
 * Mongoose setter on a nullable path and safe to apply twice.
 *
 * @param {*} value
 * @returns {*} `enc.v1.<iv>.<tag>.<ciphertext>`, all base64url.
 */
function encryptSecret(value) {
    if (typeof value !== 'string' || value === '' || isEncrypted(value)) return value;

    const key = encryptionKey();
    if (!key) return value;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return PREFIX + [iv, tag, ciphertext].map(b => b.toString('base64url')).join('.');
}

/**
 * Reads a stored secret back.
 *
 * A value with no prefix is returned as-is: that is either a key written before
 * encryption was configured, or an install that never configured it. Both are
 * ordinary states, not errors.
 *
 * A value that *is* encrypted and cannot be opened returns null, having said so
 * once on the log. That happens when `SECRET_ENCRYPTION_KEY` is unset, rotated
 * without re-encrypting, or the stored bytes were altered — and null is the
 * useful answer for all three, because every caller falls back to the bot-wide
 * key from the environment. Returning the ciphertext instead would send it to
 * the provider as an API key and report the outcome as an auth failure.
 *
 * @param {*} value
 * @returns {string|null}
 */
function decryptSecret(value) {
    if (typeof value !== 'string' || value === '') return value || null;
    if (!isEncrypted(value)) return value;

    const key = encryptionKey();
    if (!key) {
        warnOnce('no-key', '[SECRETS] A stored secret is encrypted but SECRET_ENCRYPTION_KEY is not set; falling back to the environment key.');
        return null;
    }

    const parts = value.slice(PREFIX.length).split('.');
    if (parts.length !== 3) {
        warnOnce('malformed', '[SECRETS] A stored secret is malformed and cannot be decrypted.');
        return null;
    }

    try {
        const [iv, tag, ciphertext] = parts.map(p => Buffer.from(p, 'base64url'));
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        // Deliberately not `err.message`: it says nothing useful beyond
        // "unable to authenticate data", and the value itself must not be logged.
        warnOnce('undecryptable', '[SECRETS] A stored secret could not be decrypted — wrong SECRET_ENCRYPTION_KEY, or the value was altered.');
        return null;
    }
}

// One line per distinct cause, not one per guild per message.
const warned = new Set();
function warnOnce(kind, message) {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.warn(message);
}

/** Test seam: drops the derived-key and warned-once caches. */
function _resetSecretBox() {
    cached = null;
    warned.clear();
}

module.exports = {
    encryptSecret,
    decryptSecret,
    isEncrypted,
    encryptionEnabled,
    _resetSecretBox,
    PREFIX,
};
