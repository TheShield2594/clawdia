'use strict';

const { decryptSecret, guildSecretBinding } = require('../../config/secretBox');

/**
 * Whose API key a guild's AI requests authenticate with, and what that
 * permits (#1147).
 *
 * A guild with no key of its own used to fall back to the operator's bot-wide
 * key from the environment, and the limits on that spend — per-user rate, the
 * monthly cost cap — were guild settings where 0 means unlimited. So an admin
 * of any guild the bot was invited to could switch AI on without a key, zero
 * the limits, and run up the operator's bill. Three changes close that:
 *
 *   - The operator decides which guilds may use the environment keys at all,
 *     with AI_ENV_KEY_GUILDS. Empty means none of them.
 *   - When the environment key is in use, operator ceilings apply on top of the
 *     guild's limits. A guild can set tighter limits, never looser ones.
 *   - A guild key that is stored but will not open is reported as such, not
 *     quietly swapped for the operator's key.
 */

// The window the per-user ceiling is counted over. Fixed rather than a fourth
// variable: it is the guild settings' own default window, and the ceiling's
// number is what an operator tunes.
const ENV_KEY_WINDOW_MIN = 10;

const ENV_KEY_DEFAULTS = {
    userLimit: 20,          // messages per user per ENV_KEY_WINDOW_MIN
    monthlyCost: 10,        // USD per guild per month
    monthlyTokens: 5_000_000 // per guild per month; covers providers with no price table
};

/**
 * Whether this guild may spend the operator's environment keys.
 *
 * `AI_ENV_KEY_GUILDS` is a comma- or space-separated list of guild IDs, or `*`
 * for every guild. Unset or empty means none: the operator's key is only
 * spent where the operator has said it may be. A request with no guild to name
 * is refused too.
 */
function envKeyAllowed(guildId) {
    const raw = String(process.env.AI_ENV_KEY_GUILDS || '').trim();
    if (!raw) return false;
    if (raw === '*') return true;
    if (typeof guildId !== 'string' || !guildId) return false;
    return raw.split(/[\s,]+/).includes(guildId);
}

// One line per malformed variable, not one per request.
const warned = new Set();

function ceilingFromEnv(name, raw, fallback) {
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        if (!warned.has(name)) {
            warned.add(name);
            console.warn(`[AI] Ignoring ${name}="${raw}": expected a number of 0 or more. Using ${fallback}.`);
        }
        return fallback;
    }
    return n;
}

/**
 * The operator's ceilings on spend through the environment keys. `0` is the
 * operator deliberately lifting that ceiling; an unset or malformed value is
 * the default.
 */
function envKeyCeilings() {
    return {
        userLimit: ceilingFromEnv('AI_ENV_KEY_USER_LIMIT', process.env.AI_ENV_KEY_USER_LIMIT, ENV_KEY_DEFAULTS.userLimit),
        monthlyCost: ceilingFromEnv('AI_ENV_KEY_MONTHLY_COST', process.env.AI_ENV_KEY_MONTHLY_COST, ENV_KEY_DEFAULTS.monthlyCost),
        monthlyTokens: ceilingFromEnv('AI_ENV_KEY_MONTHLY_TOKENS', process.env.AI_ENV_KEY_MONTHLY_TOKENS, ENV_KEY_DEFAULTS.monthlyTokens)
    };
}

/** The tighter of a guild limit and a ceiling, where 0 means "none". */
function tighter(guildLimit, ceiling) {
    if (!(ceiling > 0)) return guildLimit;
    return guildLimit > 0 ? Math.min(guildLimit, ceiling) : ceiling;
}

/**
 * A guild's `rateLimit` block with the operator's ceilings applied.
 *
 * The per-user limit is a rate, so it is compared as one: a guild allowing 5
 * messages an hour is already inside a 20-per-10-minutes ceiling and keeps its
 * own setting, while one allowing 100 a minute, or no limit at all, is held to
 * the ceiling. When that moves the window, the per-channel limit is rescaled
 * with it, rounding down, so a longer channel window is not quietly turned
 * into the same count over a shorter one.
 */
function applyEnvKeyCeilings(rateLimit, ceilings = envKeyCeilings()) {
    const capped = { ...rateLimit };
    const window = rateLimit.windowMin || ENV_KEY_WINDOW_MIN;

    if (ceilings.userLimit > 0) {
        const guildRate = rateLimit.perUser > 0 ? rateLimit.perUser / window : Infinity;
        if (guildRate > ceilings.userLimit / ENV_KEY_WINDOW_MIN) {
            capped.perUser = ceilings.userLimit;
            capped.windowMin = ENV_KEY_WINDOW_MIN;
            if (rateLimit.perChannel > 0 && window !== ENV_KEY_WINDOW_MIN) {
                capped.perChannel = Math.max(1, Math.floor(rateLimit.perChannel * ENV_KEY_WINDOW_MIN / window));
            }
        }
    }

    capped.monthlyCost = tighter(rateLimit.monthlyCost, ceilings.monthlyCost);
    capped.monthlyTokens = tighter(rateLimit.monthlyTokens, ceilings.monthlyTokens);
    return capped;
}

/**
 * The API key a guild's AI requests to one provider authenticate with.
 *
 * The guild's own dashboard-entered key comes first, opened under the binding
 * it was sealed to (#1152) — which is why the guild has to be named: a key
 * sealed to one guild will not open for another. Otherwise the operator's
 * key from the environment, if this guild is allowed it.
 *
 * `keySource` says which one answered (`'guild'`, `'env'` or null), so the
 * caller can apply the operator's ceilings to environment spend. `keyError`
 * says why there is no key when there is a reason worth telling someone:
 * `'undecryptable'` for a stored key that will not open — deliberately *not*
 * a fallback to the operator's key, which would move the guild's spend onto
 * the operator's bill without anybody deciding it should — and
 * `'env-not-allowed'` for a guild the operator has not opted in.
 *
 * @param {object} aiSettings a guild's `ai` settings subdocument
 * @param {object} spec
 * @param {string} spec.field  the settings field holding the guild key, e.g. `openaiKey`
 * @param {string} [spec.envKey] the operator's key from the environment, read
 *   by the caller as a literal environment read, so the env-drift check in
 *   tests/envExampleDrift.test.js can see which variable it is
 * @param {string} [spec.guildId] whose settings these are
 * @returns {{ apiKey: string|null, keySource: 'guild'|'env'|null, keyError?: string }}
 */
function resolveApiKey(aiSettings, { field, envKey, guildId }) {
    const stored = aiSettings?.[field];
    if (typeof stored === 'string' && stored) {
        const own = decryptSecret(stored, guildSecretBinding(guildId, `ai.${field}`));
        if (own) return { apiKey: own, keySource: 'guild' };
        return { apiKey: null, keySource: null, keyError: 'undecryptable' };
    }

    if (!envKey) return { apiKey: null, keySource: null };
    if (!envKeyAllowed(guildId)) return { apiKey: null, keySource: null, keyError: 'env-not-allowed' };
    return { apiKey: envKey, keySource: 'env' };
}

/**
 * What to tell someone whose request found no usable key, by `keyError`.
 * One sentence, so each transport can put it wherever it reports errors.
 */
function missingKeyMessage(providerLabel, keyError) {
    if (keyError === 'undecryptable') {
        return `This server's saved ${providerLabel} key could not be read. An admin needs to re-enter it in the dashboard.`;
    }
    return `${providerLabel} is not configured. Add an API key in the dashboard.`;
}

/** Test seam: forget which malformed variables have been warned about. */
function _resetApiKeyWarnings() {
    warned.clear();
}

module.exports = {
    resolveApiKey,
    envKeyAllowed,
    envKeyCeilings,
    applyEnvKeyCeilings,
    missingKeyMessage,
    ENV_KEY_DEFAULTS,
    ENV_KEY_WINDOW_MIN,
    _resetApiKeyWarnings,
};
