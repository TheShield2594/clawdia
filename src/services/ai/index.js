const { DEFAULT_CONFIRM_MODE, DEFAULT_MCP_ROUTE, DEFAULT_MCP_APPROVER, forGuild, ownerOf } = require('../../config/mcpServers');
const { providers, getProvider, DEFAULT_MODELS, supportsStructured } = require('./providers');
const { recordUsage } = require('./usage');
const { enforceRateLimit, toolCallBudget } = require('./rateLimit');
const { requestModelJson, DEFAULT_TOKEN_BUDGETS } = require('../../utils/modelJson');

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
 * @param {object} [options]
 * @param {string} [options.guildId] the guild those settings belong to. The
 *   MCP server list is bound to it (#1139): an OAuth connection authenticates
 *   as this guild's grant and nobody else's, and a config-file server scoped to
 *   named guilds is only offered to them. Without it the list resolves with no
 *   OAuth grants and none of the scoped servers
 * @returns {{provider: string, model: string, temperature: number,
 *   maxTokens: number, contextTokens: ?number, apiKey: ?string,
 *   baseUrl: ?string, mcpServers: object[], mcpConfirm: string,
 *   mcpRoute: string, rateLimit: {perUser: number, perChannel: number,
 *   windowMin: number, monthlyTokens: number, monthlyCost: number}}}
 *   `contextTokens` is null when the guild has not overridden it, meaning
 *   "take the window from the table in budget.js"
 */
function resolveProviderConfig(aiSettings, { guildId } = {}) {
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
    const mcpServers = forGuild(guildId, Array.isArray(aiSettings.mcpServers) ? aiSettings.mcpServers : []);
    // Which of those servers' tools need a person to approve them. Rides along
    // for the same reason: a transport that can ask should not have to know the
    // setting exists, only how to answer when the toolkit asks it to.
    const mcpConfirm = aiSettings.mcpConfirm || DEFAULT_CONFIRM_MODE;
    // Only Anthropic reads this — it is the one provider with two ways to reach
    // a server — but it rides along with the rest so no caller has to know that.
    const mcpRoute = aiSettings.mcpRoute || DEFAULT_MCP_ROUTE;
    // Who may approve a call that is waiting on a person (#1143). Read by the
    // Discord transports that build the approval prompt.
    const mcpApprover = aiSettings.mcpApprover || DEFAULT_MCP_APPROVER;

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
        mcpApprover,
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

/**
 * The request's MCP server list, bound to the guild the request is for (#1139).
 *
 * `resolveProviderConfig` binds it already when it is told the guild; this is
 * the net under the callers that spread a config resolved without one. A list
 * that already has an owner keeps it — the guild whose settings it was read
 * from is the one that decides whose grants it may use.
 */
function ownedServers(mcpServers, guildId) {
    if (!Array.isArray(mcpServers) || ownerOf(mcpServers) || !guildId) return mcpServers;
    return forGuild(guildId, mcpServers);
}

async function* streamProvider({ provider, guildId, mcp = true, usageOut, ...req }) {
    req.mcpServers = ownedServers(req.mcpServers, guildId);
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
        mcpServers: ownedServers(req.mcpServers, guildId),
        useMcp: mcp,
        toolBudget: toolCallBudget({ guildId, userId, rateLimit })
    });
    if (guildId && result.usage) {
        recordUsage(guildId, provider, req.model, result.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
    return result.text;
}

/**
 * One JSON object, schema-constrained where the provider can do it natively and
 * prompt-and-parsed where it cannot (#1044).
 *
 * A provider that supports native structured output — OpenAI Structured
 * Outputs, Gemini `responseSchema`, Anthropic tool-forcing — answers under
 * `schema` in a single request, so the malformed-JSON recovery in
 * utils/modelJson.js is unreachable on that path and a schema violation cannot
 * arrive. A provider that does not — Ollama, most OpenRouter models — takes the
 * old route: the prompt asks for JSON and `requestModelJson` strips the fence,
 * isolates the outermost braces, and grows the token budget on a truncated
 * answer. Either way this returns a plain object and the caller's own coercion —
 * enum whitelists, target clamps, sanitisation — runs on it: the schema is a
 * guard in front of that coercion, not a replacement for it.
 *
 * Limits are enforced before the provider is touched and usage is recorded
 * against the guild afterwards, exactly as getCompletion does — a structured
 * call is bounded by the guild's AI limits like any other. Tools are off on both
 * paths: a structured turn must answer in the schema, and tool output would only
 * muddy the format the caller expects.
 *
 * @param {object} args a `resolveProviderConfig` result plus the request, with:
 * @param {object} args.schema the JSON schema the object must satisfy
 * @param {string} [args.schemaName] a name for it, where the provider takes one
 * @param {number} [args.maxTokens] budget for the single native request;
 *   defaults to the largest fallback budget
 * @param {number[]} [args.budgets] the fallback retry budgets (utils/modelJson)
 * @returns {Promise<object>} the parsed object
 * @throws {AiRateLimitError|AiBudgetError} before the provider is touched
 */
async function getStructuredCompletion({ provider, guildId, userId, channelId, rateLimit, schema, schemaName, maxTokens, budgets = DEFAULT_TOKEN_BUDGETS, ...req }) {
    const providerImpl = getProvider(provider);

    if (typeof providerImpl.structured === 'function' && supportsStructured(provider, req.model)) {
        enforceRateLimit({ guildId, userId, channelId, rateLimit });
        const result = await providerImpl.structured({
            ...req,
            schema,
            schemaName,
            maxTokens: maxTokens ?? budgets[budgets.length - 1]
        });
        if (guildId && result.usage) {
            recordUsage(guildId, provider, req.model, result.usage).catch(err =>
                console.error('[AI usage] record error:', err.message));
        }
        return result.data;
    }

    // No native support: the prompt carries the JSON instruction and this is the
    // recovery the malformed-answer retry lives in. Each budget is its own
    // getCompletion — so limits are enforced and usage recorded per attempt,
    // unchanged from when the two commands called it directly.
    return requestModelJson(
        runMaxTokens => getCompletion({
            provider, guildId, userId, channelId, rateLimit,
            ...req, maxTokens: runMaxTokens, mcp: false
        }),
        { budgets }
    );
}

module.exports = { resolveProviderConfig, streamCompletion, getCompletion, getStructuredCompletion, DEFAULT_MODELS };
