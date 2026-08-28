// Provider registry (#615). Each provider implements one interface:
//
//   {
//     name, label, defaultModel,
//     pricing: [{ match: RegExp, in: $/1M input, out: $/1M output }],
//     mcp: 'native' | 'client' | false,
//     resolveAuth(aiSettings) -> { apiKey } | { baseUrl },
//     validateModel?(model)   -> error string | null,
//     supportsVision?(model)  -> whether this model can be shown an image;
//                                absent means text-only,
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

/**
 * Whether this request will run the bot's own tool loop.
 *
 * The transport asks before it builds the request, because the in-channel
 * actions are tools on that loop and a trailing ACTION block without it (#832),
 * and offering both would let a model do the same thing twice. Every 'client'
 * provider always does; Anthropic answers per request, since it is the one with
 * a connector to take instead.
 */
function usesClientTools(providerName, req = {}) {
    const provider = providers.get(providerName);
    if (!provider) return false;
    if (typeof provider.usesClientRoute === 'function') return provider.usesClientRoute(req);
    return provider.mcp === 'client';
}

/**
 * Whether this provider and model can be shown an image attachment (#839).
 *
 * Asked by the Discord transport before it downloads anything: a model that
 * cannot see is not worth the round trip, and the user is owed a note saying
 * their screenshot did not make it. A provider with no answer — one written
 * before vision existed — is text-only.
 */
function supportsVision(providerName, model) {
    const provider = providers.get(providerName);
    return typeof provider?.supportsVision === 'function'
        ? Boolean(provider.supportsVision(model))
        : false;
}

module.exports = { providers, getProvider, DEFAULT_MODELS, mcpMode, usesClientTools, supportsVision };
