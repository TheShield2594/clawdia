// Provider registry (#615). Each provider implements one interface:
//
//   {
//     name, label, defaultModel,
//     pricing: [{ match: RegExp, in: $/1M input, out: $/1M output }],
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

module.exports = { providers, getProvider, DEFAULT_MODELS };
