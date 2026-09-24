const mongoose = require('mongoose');
const {
    encryptSecret, decryptSecret, isEncrypted, encryptionEnabled,
} = require('../config/secretBox');

/**
 * Encrypts the static MCP tokens already stored on guild connections (#1146).
 *
 * `ai.mcpServers[].authorizationToken` gained the same `set: encryptSecret` the
 * provider keys have, but a setter only runs on a value being written, so every
 * token saved before this deploy is still plaintext in the document and in every
 * nightly `mongodump`. These are GitHub PATs, mailbox API keys, Stripe keys: the
 * same class of credential migration 018 covered for the provider keys, so the
 * same sweep, shaped for an array.
 *
 * Opt-in the same way 018 is. With no `SECRET_ENCRYPTION_KEY` it logs how many
 * tokens are in the clear and records itself as applied; `npm run
 * secrets:encrypt` runs this sweep on demand once the key is set.
 *
 * The driver directly, not the model, for 018's reasons: no revalidation of
 * unrelated fields, and the encryption visible where it happens.
 */

const guildsWithTokens = () => mongoose.connection.db.collection('guilds').find(
    { 'ai.mcpServers.authorizationToken': { $type: 'string', $ne: '' } },
    { projection: { guildId: 1, 'ai.mcpServers.name': 1, 'ai.mcpServers.authorizationToken': 1 } },
);

/**
 * Writes one connection's token, but only if it still holds the value read.
 *
 * Matched by name and by the value together, so an admin re-saving the token
 * from the dashboard mid-sweep — which the schema setter already encrypted — is
 * not overwritten with the old one. A miss is skipped for the same reason 018
 * skips one: the new value is already sealed.
 */
async function compareAndSet(id, name, expected, value) {
    const result = await mongoose.connection.db.collection('guilds').updateOne(
        { _id: id, 'ai.mcpServers': { $elemMatch: { name, authorizationToken: expected } } },
        { $set: { 'ai.mcpServers.$.authorizationToken': value } },
    );
    return result.matchedCount === 1;
}

function tokensOf(doc) {
    return (doc.ai?.mcpServers || [])
        .filter(server => typeof server?.name === 'string'
            && typeof server.authorizationToken === 'string'
            && server.authorizationToken !== '');
}

/**
 * Rewrites every plaintext MCP token as ciphertext. Idempotent.
 *
 * @returns {Promise<{ guilds: number, tokens: number, skipped: number }>}
 * @throws if `SECRET_ENCRYPTION_KEY` is not configured.
 */
async function encryptStoredMcpTokens() {
    if (!encryptionEnabled()) {
        throw new Error('SECRET_ENCRYPTION_KEY is not set, so there is no key to encrypt with.');
    }

    let guilds = 0;
    let tokens = 0;
    let skipped = 0;

    for await (const doc of guildsWithTokens()) {
        let written = 0;
        for (const server of tokensOf(doc)) {
            if (isEncrypted(server.authorizationToken)) continue;
            if (await compareAndSet(doc._id, server.name, server.authorizationToken, encryptSecret(server.authorizationToken))) written++;
            else skipped++;
        }
        if (!written) continue;
        guilds++;
        tokens += written;
    }

    return { guilds, tokens, skipped };
}

/**
 * The reverse, for `down()`. Refuses on a value it cannot open rather than
 * overwriting a credential with something that is not it.
 */
async function decryptStoredMcpTokens() {
    if (!encryptionEnabled()) {
        throw new Error('SECRET_ENCRYPTION_KEY is not set — the stored MCP tokens cannot be decrypted, ' +
            'and overwriting them would destroy them.');
    }

    let tokens = 0;
    let skipped = 0;

    for await (const doc of guildsWithTokens()) {
        for (const server of tokensOf(doc)) {
            if (!isEncrypted(server.authorizationToken)) continue;
            const plain = decryptSecret(server.authorizationToken);
            if (plain === null) {
                throw new Error(`Cannot decrypt the MCP token for "${server.name}" in guild ${doc.guildId}.`);
            }
            if (await compareAndSet(doc._id, server.name, server.authorizationToken, plain)) tokens++;
            else skipped++;
        }
    }

    return { tokens, skipped };
}

/** How many stored MCP tokens are still in the clear. Never logs one. */
async function countPlaintextMcpTokens() {
    let count = 0;
    for await (const doc of guildsWithTokens()) {
        count += tokensOf(doc).filter(server => !isEncrypted(server.authorizationToken)).length;
    }
    return count;
}

module.exports = {
    name: '027_encrypt_mcp_tokens',

    async up() {
        if (!encryptionEnabled()) {
            const plaintext = await countPlaintextMcpTokens();
            console.log(
                `[MIGRATIONS] 027: SECRET_ENCRYPTION_KEY is not set — leaving ${plaintext} MCP server ` +
                'token(s) stored in the clear. To encrypt them later: set SECRET_ENCRYPTION_KEY ' +
                '(openssl rand -base64 32) and run `npm run secrets:encrypt`.'
            );
            return;
        }

        const { guilds, tokens, skipped } = await encryptStoredMcpTokens();
        console.log(`[MIGRATIONS] 027: encrypted ${tokens} MCP server token(s) at rest across ${guilds} guild(s).`);
        if (skipped) {
            console.warn(
                `[MIGRATIONS] 027: ${skipped} token(s) were rewritten by another process mid-sweep and ` +
                'left as they were found. Re-run `npm run secrets:encrypt` once that process has stopped.'
            );
        }
    },

    async down() {
        const { tokens, skipped } = await decryptStoredMcpTokens();
        console.log(`[MIGRATIONS] 027: restored ${tokens} MCP server token(s) to plaintext.`);
        if (skipped) {
            throw new Error(
                `[MIGRATIONS] 027 rollback is incomplete: ${skipped} token(s) were rewritten by another ` +
                'process mid-rollback and are still encrypted. Stop the bot and roll back again.'
            );
        }
    },

    encryptStoredMcpTokens,
    decryptStoredMcpTokens,
    countPlaintextMcpTokens,
};
