const openai = require('./openai');

// OpenRouter is OpenAI-compatible: same wire protocol, different base URL and
// attribution headers.
function withOpenRouter(req) {
    return {
        ...req,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
            'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/TheShield2594/clawdia',
            'X-Title': 'Clawdia'
        }
    };
}

module.exports = {
    name: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o-mini',
    // Pricing varies per routed model; unknown without an API call.
    pricing: [],
    // Inherited along with the rest of the OpenAI request path: MCP tools are
    // offered as functions and called by the loop in openai.js. Whether the
    // *routed* model supports tool calling is up to the model.
    mcp: 'client',
    resolveAuth: aiSettings => ({ apiKey: aiSettings.openrouterKey || process.env.OPENROUTER_API_KEY }),
    // OpenRouter model ids are namespaced; a bare model name is a config error
    // that would otherwise surface as an opaque 400 from the API.
    validateModel: model => (model && !model.includes('/'))
        ? `OpenRouter model names must include a provider prefix (e.g. \`openai/gpt-4o-mini\`). Your current model \`${model}\` is missing the prefix — update it in the AI settings dashboard.`
        : null,
    stream: req => openai.stream(withOpenRouter(req)),
    complete: req => openai.complete(withOpenRouter(req))
};
