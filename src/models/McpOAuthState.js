'use strict';

const { Schema, model } = require('mongoose');
const { encryptSecret } = require('../config/secretBox');

/**
 * One OAuth authorization flow, in flight (#796).
 *
 * The flow spans two HTTP requests to the dashboard — the admin clicks Connect,
 * goes off to somebody else's consent screen, and comes back to the callback —
 * and the PKCE verifier has to survive in between. In-process memory would do
 * that in a single-process install and quietly fail in a sharded one, where the
 * callback can land on a different process from the one that started the flow;
 * a document with a TTL works in both and needs no cleanup job.
 *
 * `_id` is the `state` parameter, which makes the callback's lookup the CSRF
 * check: a callback carrying a state nobody issued finds no document and goes
 * no further. It is 32 random bytes, so it is not guessable, and it is consumed
 * on first use so a replayed callback finds nothing either.
 *
 * Two fields here are secrets, and both are encrypted at rest the way the grant
 * they will become is. The client secret is the same value the finished grant
 * stores sealed — a transient record is no reason to hold it in the clear, and
 * an abandoned flow is exactly the record most likely to still be sitting there
 * when somebody reads a backup. The PKCE verifier is worthless without the
 * authorization code it pairs with and lives for ten minutes, so it earns less
 * of an argument; it is sealed alongside because leaving one of the two in
 * plaintext is the sort of asymmetry nobody remembers the reason for.
 *
 * `encryptSecret` is a no-op when the operator has configured no key, so this
 * changes nothing for an install that has not opted in — see
 * src/config/secretBox.js.
 */
const mcpOAuthStateSchema = new Schema({
    // The `state` parameter. Named `_id` so the unique index is the one the
    // collection already has.
    _id:       { type: String, required: true },
    guildId:   { type: String, required: true },
    // Which of the guild's MCP servers this flow is for.
    server:    { type: String, required: true },
    verifier:  { type: String, required: true, set: encryptSecret },
    // Where the browser will come back to. Stored rather than recomputed
    // because the token exchange has to send back the identical string, and a
    // dashboard reachable under two names would otherwise fail the comparison.
    redirectUri: { type: String, required: true },
    // The discovery result, so the callback does not have to fetch it all again
    // — and, more to the point, so the token request goes to the endpoint that
    // was discovered when the flow started rather than to whatever the server
    // is advertising by the time the admin finishes reading the scope list.
    discovery: { type: Schema.Types.Mixed, required: true },
    clientId:  { type: String, required: true },
    clientSecret: { type: String, default: null, set: encryptSecret },
    // Who started it, for the audit entry the callback writes.
    startedBy: { type: String, default: null },
    expiresAt: { type: Date, required: true },
});

// Mongo's TTL monitor deletes an abandoned flow within a minute of its expiry,
// so nothing here needs sweeping and an admin who closes the consent tab leaves
// nothing behind.
mcpOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
mcpOAuthStateSchema.index({ guildId: 1, server: 1 });

module.exports = model('McpOAuthState', mcpOAuthStateSchema);
