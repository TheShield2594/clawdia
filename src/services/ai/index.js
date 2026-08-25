const { DEFAULT_CONFIRM_MODE, DEFAULT_MCP_ROUTE } = require('../../config/mcpServers');
const { providers, getProvider, DEFAULT_MODELS } = require('./providers');
const { recordUsage } = require('./usage');
const { enforceRateLimit } = require('./rateLimit');

// Core provider dispatch: resolve a guild's AI settings to a provider config
// and route completions through the provider registry. Both the streaming and
// non-streaming paths are a single registry lookup — adding a provider means
// adding one module to providers/, nothing here changes.

function resolveProviderConfig(aiSettings) {
    const providerName = aiSettings.provider || 'openai';
    const model = aiSettings.model || DEFAULT_MODELS[providerName];
    const temperature = aiSettings.temperature ?? 0.7;
    const maxTokens = aiSettings.maxTokens ?? 1024;

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
    const rateLimit = {
        perUser: aiSettings.rateLimitPerUser ?? 0,
        perChannel: aiSettings.rateLimitPerChannel ?? 0,
        windowMin: aiSettings.rateLimitWindowMin ?? 10
    };

    return {
        provider: providerName,
        model,
        temperature,
        maxTokens,
        apiKey: auth.apiKey ?? null,
        baseUrl: auth.baseUrl ?? null,
        mcpServers,
        mcpConfirm,
        mcpRoute,
        rateLimit
    };
}

// `mcp` controls whether configured MCP servers are offered to the model. It is
// on by default for conversational calls; callers that parse the reply as JSON
// pass mcp: false so tool output cannot derail the format they expect.
// Deliberately not an async generator itself: the limit has to be spent when
// the caller asks for the stream, not when it pulls the first chunk. The
// Discord transport posts a placeholder message before it starts iterating, so
// a lazy check would put "…" on screen for a request that was never allowed.
function streamCompletion({ userId, channelId, rateLimit, ...args }) {
    // Before the provider is touched: every route into a paid API goes through
    // here, so this is the only place a limit has to be applied to bound spend.
    // guildId stays in `args` as well — it is what the usage ledger records
    // under, and here it is what scopes the per-user window to one server.
    enforceRateLimit({ guildId: args.guildId, userId, channelId, rateLimit });
    return streamProvider(args);
}

async function* streamProvider({ provider, guildId, mcp = true, usageOut, ...req }) {
    yield* getProvider(provider).stream({ ...req, usageOut, useMcp: mcp });
    if (guildId && usageOut?.usage) {
        recordUsage(guildId, provider, req.model, usageOut.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
}

async function getCompletion({ provider, guildId, mcp = true, userId, channelId, rateLimit, ...req }) {
    enforceRateLimit({ guildId, userId, channelId, rateLimit });
    const result = await getProvider(provider).complete({ ...req, useMcp: mcp });
    if (guildId && result.usage) {
        recordUsage(guildId, provider, req.model, result.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
    return result.text;
}

module.exports = { resolveProviderConfig, streamCompletion, getCompletion, DEFAULT_MODELS };
