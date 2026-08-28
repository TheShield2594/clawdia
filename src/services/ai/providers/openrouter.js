const openai = require('./openai');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const { decryptSecret } = require('../../../config/secretBox');

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

// The vendor half of an OpenRouter model id, and who answers for it.
const VENDORS = {
    openai,
    anthropic,
    google: gemini
};

// For everyone else, the model name has to say so itself. OpenRouter routes to
// dozens of vendors this bot has no module for, and a model without vision
// handed an image answers with a 400 — so an unrecognised name is asked in text
// alone, which is what OpenRouter guilds had before this existed (#839).
const VISION_NAMES = /(vision|-vl\b|llava|pixtral|internvl|llama-?4|gemma-?3|qwen2\.?5?-?vl)/i;

/**
 * Whether the *routed* model can be shown an image.
 *
 * The id is `vendor/model`, so where the vendor is one this bot already has a
 * module for its own answer is used — which keeps one list of OpenAI vision
 * models rather than two that drift.
 */
function supportsVision(model) {
    const id = String(model || '');
    const slash = id.indexOf('/');
    if (slash < 0) return false;

    const vendor = VENDORS[id.slice(0, slash).toLowerCase()];
    // The routed name can carry a variant suffix (`:free`, `:nitro`) that the
    // vendor's own matcher has never seen.
    const name = id.slice(slash + 1).split(':')[0];
    return vendor ? vendor.supportsVision(name) : VISION_NAMES.test(name);
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
    supportsVision,
    resolveAuth: aiSettings => ({ apiKey: decryptSecret(aiSettings.openrouterKey) || process.env.OPENROUTER_API_KEY }),
    // OpenRouter model ids are namespaced; a bare model name is a config error
    // that would otherwise surface as an opaque 400 from the API.
    validateModel: model => (model && !model.includes('/'))
        ? `OpenRouter model names must include a provider prefix (e.g. \`openai/gpt-4o-mini\`). Your current model \`${model}\` is missing the prefix — update it in the AI settings dashboard.`
        : null,
    stream: req => openai.stream(withOpenRouter(req)),
    complete: req => openai.complete(withOpenRouter(req))
};
