const { providers, getProvider, DEFAULT_MODELS } = require('./providers');
const { recordUsage } = require('./usage');

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

    return {
        provider: providerName,
        model,
        temperature,
        maxTokens,
        apiKey: auth.apiKey ?? null,
        baseUrl: auth.baseUrl ?? null,
        mcpServers
    };
}

// `mcp` controls whether configured MCP servers are offered to the model. It is
// on by default for conversational calls; callers that parse the reply as JSON
// pass mcp: false so tool output cannot derail the format they expect.
async function* streamCompletion({ provider, guildId, mcp = true, usageOut, ...req }) {
    yield* getProvider(provider).stream({ ...req, usageOut, useMcp: mcp });
    if (guildId && usageOut?.usage) {
        recordUsage(guildId, provider, req.model, usageOut.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
}

async function getCompletion({ provider, guildId, mcp = true, ...req }) {
    const result = await getProvider(provider).complete({ ...req, useMcp: mcp });
    if (guildId && result.usage) {
        recordUsage(guildId, provider, req.model, result.usage).catch(err =>
            console.error('[AI usage] record error:', err.message));
    }
    return result.text;
}

module.exports = { resolveProviderConfig, streamCompletion, getCompletion, DEFAULT_MODELS };
