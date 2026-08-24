// Provider registry (#615). Each provider implements one interface:
//
//   {
//     name, label, defaultModel,
//     pricing: [{ match: RegExp, in: $/1M input, out: $/1M output }],
//     mcp: 'native' | 'client' | false,
//     resolveAuth(aiSettings) -> { apiKey } | { baseUrl },
//     validateModel?(model)   -> error string | null,
//     stream(req)             -> async generator of text deltas; sets
//                                req.usageOut.usage when the provider reports it,
//     complete(req)           -> { text, usage|null },
//   }
//
// Adding a provider means writing one module against this interface and
// listing it here — dispatch, defaults, labels and pricing all follow from
// the registry, so there is no second site to edit.
//
// `mcp` says how a provider reaches MCP servers: 'native' when the API takes
// the servers itself (Anthropic), 'client' when the bot lists and calls the
// tools through src/services/ai/mcp/ and feeds them to the model as functions,
// false for a provider that cannot do either.

const PROVIDER_LIST = [
    require('./openai'),
    require('./gemini'),
    require('./anthropic'),
    require('./ollama'),
    require('./openrouter')
];

const providers = new Map(PROVIDER_LIST.map(p => [p.name, p]));

function getProvider(name) {
    const provider = providers.get(name);
    if (!provider) throw new Error(`Unknown provider: ${name}`);
    return provider;
}

const DEFAULT_MODELS = Object.fromEntries(PROVIDER_LIST.map(p => [p.name, p.defaultModel]));

/**
 * How a provider reaches MCP servers, by name: 'native', 'client', or false for
 * one that cannot. Asked by the dashboard and the Discord transport, so neither
 * has to keep its own list of which providers MCP applies to.
 */
function mcpMode(providerName) {
    return providers.get(providerName)?.mcp || false;
}

module.exports = { providers, getProvider, DEFAULT_MODELS, mcpMode };
