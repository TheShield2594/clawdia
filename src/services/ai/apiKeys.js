'use strict';

const { decryptSecret, guildSecretBinding } = require('../../config/secretBox');

/**
 * The API key a guild's AI requests to one provider authenticate with.
 *
 * The guild's own dashboard-entered key comes first, opened under the binding
 * it was sealed to (#1152) — which is why the guild has to be named: a key
 * sealed to one guild will not open for another. Otherwise the operator's
 * bot-wide key from the environment.
 *
 * @param {object} aiSettings a guild's `ai` settings subdocument
 * @param {object} spec
 * @param {string} spec.field  the settings field holding the guild key, e.g. `openaiKey`
 * @param {string} [spec.envKey] the operator's key from the environment, read by
 *   the caller as a literal `process.env.X` so the env-drift checks can see it
 * @param {string} [spec.guildId] whose settings these are
 * @returns {{ apiKey: string|null }}
 */
function resolveApiKey(aiSettings, { field, envKey, guildId }) {
    const own = decryptSecret(aiSettings?.[field], guildSecretBinding(guildId, `ai.${field}`));
    return { apiKey: own || envKey || null };
}

module.exports = { resolveApiKey };
