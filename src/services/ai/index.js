const { DEFAULT_CONFIRM_MODE, DEFAULT_MCP_ROUTE, DEFAULT_MCP_APPROVER, forGuild, ownerOf } = require('../../config/mcpServers');
const { providers, getProvider, DEFAULT_MODELS, supportsStructured } = require('./providers');
const { recordUsage } = require('./usage');
const { enforceRateLimit, toolCallBudget, guildLimitsOf } = require('./rateLimit');
const { applyEnvKeyCeilings } = require('./apiKeys');
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
 * guild's dashboard-entered key before the bot-wide environment fallback — the
 * fallback only for guilds the operator allows it (services/ai/apiKeys.js). A
 * provider that resolves neither yields `apiKey: null` rather than throwing,
 * with `keyError` saying why when there is a reason worth telling someone.
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
 *   keySource: ?string, keyError: ?string, baseUrl: ?string, mcpServers: object[], mcpConfirm: string,
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

    const auth = providers.get(providerName)?.resolveAuth(aiSettings, { guildId }) || {};

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
    const guildLimits = guildLimitsOf(aiSettings);
    // Spend on the operator's environment key is the operator's money, so
    // their ceilings bind it whatever the guild set (#1147). A guild can only
    // tighten them — its own limits are 0-for-unlimited, and those zeroes are
    // exactly how the operator's bill used to be run up.
    const rateLimit = auth.keySource === 'env' ? applyEnvKeyCeilings(guildLimits) : guildLimits;

    return {
        provider: providerName,
        model,
        temperature,
        maxTokens,
        contextTokens,
        apiKey: auth.apiKey ?? null,
        keySource: auth.keySource ?? null,
        keyError: auth.keyError ?? null,
        baseUrl: auth.baseUrl ?? null,
        mcpServers,
        mcpConfirm,
        mcpRoute,
        mcpApprover,
        rateLimit,
        fallbacks: resolveFallbacks(aiSettings, { guildId, primary: providerName, primaryKeySource: auth.keySource ?? null })
    };
}

// How many backups a guild may list. One is the usual case — a second vendor
// for when the first is down — and two covers "and then a local model".
const MAX_FALLBACKS = 2;

/**
 * The backup providers a guild listed (`ai.fallbacks`), each resolved to the
 * fields that differ per provider, in order. A backup with no usable
 * credential is left out rather than tried and failed.
 *
 * One exception keeps the operator's money where it was: a backup that would
 * run on the operator's environment key is only kept when the primary does too.
 * The rate limits enforced on a request are the primary's, and only an
 * env-key primary carries the operator's ceilings (#1147); a guild on its own
 * key must not be able to spill its traffic onto the operator's bill by naming
 * a backup it has no key for.
 */
function resolveFallbacks(aiSettings, { guildId, primary, primaryKeySource }) {
    const listed = Array.isArray(aiSettings.fallbacks) ? aiSettings.fallbacks.slice(0, MAX_FALLBACKS) : [];
    const out = [];
    for (const entry of listed) {
        const name = entry?.provider;
        const providerDef = name && providers.get(name);
        if (!providerDef) continue;
        const model = (typeof entry.model === 'string' && entry.model.trim()) || DEFAULT_MODELS[name];
        // The same provider and model as the primary is not a backup.
        if (name === primary && model === (aiSettings.model || DEFAULT_MODELS[primary])) continue;
        const auth = providerDef.resolveAuth(aiSettings, { guildId }) || {};
        if (name !== 'ollama' && !auth.apiKey) continue;
        if (auth.keySource === 'env' && primaryKeySource !== 'env') continue;
        out.push({ provider: name, model, apiKey: auth.apiKey ?? null, baseUrl: auth.baseUrl ?? null });
    }
    return out;
}

// HTTP statuses that say "this provider cannot answer right now" rather than
// "this request is wrong": a backup has a real chance with any of them. A 400
// is deliberately absent — a prompt too long or a refused request is the same
// request to the next provider, and would fail there too.
const FALLBACK_STATUSES = new Set([401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

/**
 * Whether a failed call is worth trying on the next provider.
 *
 * No status at all is a connection that failed — refused, reset, timed out,
 * DNS — which is the clearest case. The bot's own refusals (rate limit, budget)
 * are never retried elsewhere: they are the guild's limits, not a provider's.
 */
function shouldFallBack(error) {
    if (!error || error.rateLimited || error.budgetExceeded || error.name === 'AiRateLimitError' || error.name === 'AiBudgetError') {
        return false;
    }
    // A cancelled request was cancelled on purpose: asking the next provider
    // would answer something nobody is waiting for any more.
    if (error.name === 'AbortError' || error.name === 'APIUserAbortError') return false;
    const status = Number(error.status ?? error.statusCode ?? error.response?.status ?? error.code);
    if (Number.isInteger(status) && status >= 100 && status < 600) return FALLBACK_STATUSES.has(status);
    return true;
}

/** The request as each provider in turn would make it. */
function attemptsFor(req) {
    const { fallbacks = [], ...primary } = req;
    return [primary, ...fallbacks.map(fallback => ({ ...primary, ...fallback }))];
}

/**
 * A tool-event listener that also records whether any tool actually ran. A
 * turn that ran one has done something in the world — filed the issue, moved
 * the event — and replaying it on another provider would do it twice.
 */
function trackTools(onToolEvent) {
    const state = { ran: false };
    const listener = event => {
        if (event?.type === 'start') state.ran = true;
        return onToolEvent?.(event);
    };
    return { state, listener };
}

function describeFailure(error) {
    const status = error?.status ?? error?.statusCode ?? error?.response?.status;
    return status ? `HTTP ${status}` : (error?.code || error?.message || 'error');
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
// `keySource` and `keyError` ride on a resolved config for the caller's
// benefit (services/ai/apiKeys.js) and are dropped here, so a provider module
// never receives them in its request.
function streamCompletion({ userId, channelId, rateLimit, keySource, keyError, ...args }) {
    // Before the provider is touched: every route into a paid API goes through
    // here, so this is the only place a limit has to be applied to bound spend.
    // guildId stays in `args` as well — it is what the usage ledger records
    // under, and here it is what scopes the per-user window to one server.
    enforceRateLimit({ guildId: args.guildId, userId, channelId, rateLimit });
    // The message is one slot; what it fans out into is bounded separately.
    // Built here for the same reason the limit is enforced here — it is the one
    // place every provider request passes through — and carried down to the MCP
    // toolkit, which is what spends it.
    return streamWithFallback({ ...args, toolBudget: toolCallBudget({ guildId: args.guildId, userId, rateLimit }) });
}

/**
 * The stream from the first provider that answers.
 *
 * Only before anything has been said: once a chunk is on screen the reply is
 * that provider's, and a second one starting over would read as two answers
 * spliced together — so a failure after the first chunk is the caller's, as it
 * always was. Never after a tool ran, for the reason `trackTools` gives.
 */
async function* streamWithFallback(req) {
    const attempts = attemptsFor(req);
    for (let i = 0; i < attempts.length; i++) {
        const { state, listener } = trackTools(req.onToolEvent);
        let yielded = false;
        try {
            for await (const chunk of streamProvider({ ...attempts[i], onToolEvent: listener })) {
                yielded = true;
                yield chunk;
            }
            return;
        } catch (error) {
            const next = attempts[i + 1];
            if (!next || yielded || state.ran || !shouldFallBack(error)) throw error;
            console.warn(`[AI] ${attempts[i].provider}/${attempts[i].model} failed (${describeFailure(error)}); answering with ${next.provider}/${next.model}`);
        }
    }
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

/**
 * Charge a request's tokens to the guild's ledger, off the caller's path.
 *
 * Also called with the usage a failed or cancelled request carries on its error
 * (#1238): every round that came back before it was billed, and a turn given up
 * on half way is still a turn the guild paid for.
 */
function chargeUsage(guildId, provider, model, usage) {
    if (!guildId || !usage) return;
    recordUsage(guildId, provider, model, usage).catch(err =>
        console.error('[AI usage] record error:', err.message));
}

async function* streamProvider({ provider, guildId, mcp = true, usageOut, ...req }) {
    req.mcpServers = ownedServers(req.mcpServers, guildId);
    try {
        yield* getProvider(provider).stream({ ...req, usageOut, useMcp: mcp });
    } catch (error) {
        chargeUsage(guildId, provider, req.model, error?.usage);
        throw error;
    }
    chargeUsage(guildId, provider, req.model, usageOut?.usage);
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
 * @param {Function} [req.toolBudget] spend tool calls from this budget instead
 *   of the one `userId` would get
 * @param {AbortSignal} [req.signal] cancels the turn (#1238): no new provider
 *   request starts once it has fired, and the one in flight is aborted
 * @returns {Promise<string>} the reply text — not the provider's result object
 * @throws {AiRateLimitError|AiBudgetError} before the provider is touched
 */
async function getCompletion({ provider, guildId, mcp = true, userId, channelId, rateLimit, keySource, keyError, toolBudget: sharedBudget, ...req }) {
    enforceRateLimit({ guildId, userId, channelId, rateLimit });
    // A delegated child turn (delegate.js) passes its parent's budget and no
    // user: it spends the parent's tool calls, not a message slot of its own.
    // Null is a budget too (the parent's is unbounded), so only a missing one
    // is worked out here — or a child would land on the scheduled-run budget.
    const toolBudget = sharedBudget !== undefined ? sharedBudget : toolCallBudget({ guildId, userId, rateLimit });
    const attempts = attemptsFor({ provider, ...req });

    for (let i = 0; i < attempts.length; i++) {
        const { provider: name, ...attempt } = attempts[i];
        const { state, listener } = trackTools(attempt.onToolEvent);
        let result;
        try {
            result = await getProvider(name).complete({
                ...attempt,
                onToolEvent: listener,
                mcpServers: ownedServers(attempt.mcpServers, guildId),
                useMcp: mcp,
                toolBudget
            });
        } catch (error) {
            chargeUsage(guildId, name, attempt.model, error?.usage);
            const next = attempts[i + 1];
            if (!next || state.ran || !shouldFallBack(error)) throw error;
            console.warn(`[AI] ${name}/${attempt.model} failed (${describeFailure(error)}); answering with ${next.provider}/${next.model}`);
            continue;
        }
        chargeUsage(guildId, name, attempt.model, result.usage);
        return result.text;
    }
    // Unreachable: the last attempt either returns or throws.
    throw new Error('no provider answered');
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
// Structured calls stay on the primary: their callers parse the answer against
// one provider's schema support, and a backup with no native structured output
// would change the shape of the failure rather than avoid it.
async function getStructuredCompletion({ provider, guildId, userId, channelId, rateLimit, schema, schemaName, maxTokens, budgets = DEFAULT_TOKEN_BUDGETS, keySource, keyError, fallbacks: _fallbacks, ...req }) {
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

module.exports = { resolveProviderConfig, streamCompletion, getCompletion, getStructuredCompletion, shouldFallBack, DEFAULT_MODELS, MAX_FALLBACKS };
