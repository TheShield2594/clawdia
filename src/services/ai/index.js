const { DEFAULT_CONFIRM_MODE, DEFAULT_MCP_ROUTE } = require('../../config/mcpServers');
const { providers, getProvider, DEFAULT_MODELS } = require('./providers');
const { recordUsage } = require('./usage');
const { enforceRateLimit, toolCallBudget } = require('./rateLimit');

// Core provider dispatch: resolve a guild's AI settings to a provider config
// and route completions through the provider registry. Both the streaming and
// non-streaming paths are a single registry lookup — adding a provider means
// adding one module to providers/, nothing here changes.

/**
 * Turn a guild's stored AI settings into the config object every call into this
 * module takes — provider, model, sampling parameters, resolved credentials,
 * and the guild's MCP servers and spend limits riding along.
 *
 * Everything a downstream caller might need is folded in here on purpose, so
 * that spreading this config is enough: a transport does not have to know MCP
 * servers exist to keep them attached, and does not have to remember to look up
 * rate limits for the enforcement below to bind.
 *
 * Credentials come from the provider's own `resolveAuth`, which reads the
 * guild's dashboard-entered key before the bot-wide environment fallback. A
 * provider that resolves neither yields `apiKey: null` rather than throwing —
 * the call fails at the provider, where the error can say which key is missing.
 *
 * @param {object} aiSettings a guild's `ai` settings subdocument
 * @returns {{provider: string, model: string, temperature: number,
 *   maxTokens: number, contextTokens: ?number, apiKey: ?string,
 *   baseUrl: ?string, mcpServers: object[], mcpConfirm: string,
 *   mcpRoute: string, rateLimit: {perUser: number, perChannel: number,
 *   windowMin: number, monthlyTokens: number, monthlyCost: number}}}
 *   `contextTokens` is null when the guild has not overridden it, meaning
 *   "take the window from the table in budget.js"
 */
function resolveProviderConfig(aiSettings) {
    const providerName = aiSettings.provider || 'openai';
    const model = aiSettings.model || DEFAULT_MODELS[providerName];
    const temperature = aiSettings.temperature ?? 0.7;
    const maxTokens = aiSettings.maxTokens ?? 1024;
    // What the guild says its model's context window is, for the case the
    // table in budget.js cannot know: a self-hosted Ollama serves whatever
    // `num_ctx` the operator loaded the model with, and nothing about the
    // model name says which. Null means "use the table" (#840).
    const contextTokens = Number.isFinite(Number(aiSettings.contextTokens)) && Number(aiSettings.contextTokens) > 0
        ? Number(aiSettings.contextTokens)
        : null;

    const auth = providers.get(providerName)?.resolveAuth(aiSettings) || {};

    // Carried through so every caller that spreads this config keeps the
    // guild's MCP servers attached without having to know they exist.
    const mcpServers = Array.isArray(aiSettings.mcpServers) ? aiSettings.mcpServers : [];
    // Which of those servers' tools need a person to approve them. Rides along
    // for the same reason: a transport that can ask should not have to know the
    // setting exists, only how to answer when the toolkit asks it to.
    const mcpConfirm = aiSettings.mcpConfirm || DEFAULT_CONFIRM_MODE;
    // Only Anthropic reads this — it is the one provider with two ways to reach
    // a server — but it rides along with the rest so no caller has to know that.
    const mcpRoute = aiSettings.mcpRoute || DEFAULT_MCP_ROUTE;

    // Same idea for the guild's AI limits: they ride along with the config so
    // getCompletion/streamCompletion can enforce them centrally, instead of
    // each call site remembering to ask. A caller only has to say *who* the
    // request is for (userId/channelId); the numbers come from here.
    // The monthly ceilings ride in the same block for the same reason, and are
    // the one limit here that also binds a call nobody sent: the scheduled
    // digests and newspapers spend this guild's money too (#831).
    const rateLimit = {
        perUser: aiSettings.rateLimitPerUser ?? 0,
        perChannel: aiSettings.rateLimitPerChannel ?? 0,
        windowMin: aiSettings.rateLimitWindowMin ?? 10,
        monthlyTokens: aiSettings.monthlyTokenLimit ?? 0,
        monthlyCost: aiSettings.monthlyCostLimit ?? 0
    };

    return {
        provider: providerName,
        model,
        temperature,
        maxTokens,
        contextTokens,
        apiKey: auth.apiKey ?? null,
        baseUrl: auth.baseUrl ?? null,
        mcpServers,
        mcpConfirm,
        mcpRoute,
        rateLimit
    };
}

/**
 * Stream a completion, spending the caller's rate-limit slot up front.
 *
 * Deliberately not an async generator itself: the limit has to be spent when
 * the caller asks for the stream, not when it pulls the first chunk. The
 * Discord transport posts a placeholder message before it starts iterating, so
 * a lazy check would put "…" on screen for a request that was never allowed.
 * Usage is recorded against the guild once the stream is exhausted.
 *
 * @param {object} args a `resolveProviderConfig` result plus the request
 * @param {string} [args.userId] who to charge the per-user window to
 * @param {string} [args.channelId] and the per-channel one
 * @param {string} [args.guildId] whose ledger and whose limits
 * @param {object} [args.rateLimit] from the resolved config
 * @param {boolean} [args.mcp] whether the guild's MCP servers are offered to
 *   the model; true by default. Callers that parse the reply as JSON pass
 *   false, so tool output cannot derail the format they expect
 * @param {object} [args.usageOut] filled in with token counts as the stream runs
 * @returns {AsyncGenerator<string>} text chunks
 * @throws {AiRateLimitError|AiBudgetError} before the provider is touched
 */
function streamCompletion({ userId, channelId, rateLimit, ...args }) {
    // Before the provider is touched: every route into a paid API goes through
    // here, so this is the only place a limit has to be applied to bound spend.
    // guildId stays in `args` as well — it is what the usage ledger records
    // under, and here it is what scopes the per-user window to one server.
    enforceRateLimit({ guildId: args.guildId, userId, channelId, rateLimit });
    // The message is one slot; what it fans out into is bounded separately.
    // Built here for the same reason the limit is enforced here — it is the one
    // place every provider request passes through — and carried down to the MCP
    // toolkit, which is what spends it.
    return streamProvider({ ...args, toolBudget: toolCallBudget({ guildId: args.guildId, userId, rateLimit }) });
}

async function* streamProvider({ provider, guildId, mcp = true, usageOut, ...req }) {
    yield* getProvider(provider).stream({ ...req, usageOut, useMcp: mcp });
    if (guildId && usageOut?.usage) {
        recordUsage(guildId, provider, req.model, usageOut.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
}

/**
 * One completion, awaited whole. The non-streaming half of the same path:
 * limits are enforced before the provider is touched and usage is recorded
 * against the guild afterwards.
 *
 * @param {object} req a `resolveProviderConfig` result plus the request
 * @param {string} req.provider which provider module answers
 * @param {string} [req.guildId] whose ledger and whose limits
 * @param {boolean} [req.mcp] offer the guild's MCP servers; true by default
 * @param {string} [req.userId]
 * @param {string} [req.channelId]
 * @param {object} [req.rateLimit]
 * @returns {Promise<string>} the reply text — not the provider's result object
 * @throws {AiRateLimitError|AiBudgetError} before the provider is touched
 */
async function getCompletion({ provider, guildId, mcp = true, userId, channelId, rateLimit, ...req }) {
    enforceRateLimit({ guildId, userId, channelId, rateLimit });
    const result = await getProvider(provider).complete({
        ...req,
        useMcp: mcp,
        toolBudget: toolCallBudget({ guildId, userId, rateLimit })
    });
    if (guildId && result.usage) {
        recordUsage(guildId, provider, req.model, result.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
    return result.text;
}

module.exports = { resolveProviderConfig, streamCompletion, getCompletion, DEFAULT_MODELS };
