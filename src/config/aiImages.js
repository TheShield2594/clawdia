'use strict';

/**
 * Which service draws a guild's images, and with which model (#1229). Shared
 * by the Guild schema, the settings endpoint and services/ai/images.js, so the
 * enum, the validator and the behaviour cannot disagree.
 *
 *   auto    follow the chat provider: Gemini for a guild on Gemini, otherwise
 *           OpenAI (the way voice chooses)
 *   openai  OpenAI first, Gemini if OpenAI fails
 *   gemini  Gemini first, OpenAI if Gemini fails
 *
 * The model fields are per service because a guild can fall back from one to
 * the other, and one name cannot be right for both. Empty means the operator's
 * OPENAI_IMAGE_MODEL / GEMINI_IMAGE_MODEL, then the built-in default.
 */
const IMAGE_SERVICES = ['auto', 'openai', 'gemini'];

const DEFAULT_IMAGE_MODELS = { openai: 'gpt-image-1', gemini: 'gemini-2.5-flash-image' };

const MAX_MODEL_CHARS = 100;

/**
 * The model a guild that has not picked one draws with on `service`: the
 * operator's OPENAI_IMAGE_MODEL / GEMINI_IMAGE_MODEL, else the built-in default.
 * Read here rather than in images.js so the dashboard can show it as the
 * placeholder without loading the AI services.
 */
function operatorImageModel(service) {
    const env = service === 'openai' ? process.env.OPENAI_IMAGE_MODEL : process.env.GEMINI_IMAGE_MODEL;
    return (env || '').trim() || DEFAULT_IMAGE_MODELS[service];
}

/**
 * Why `value` cannot be this service's image model, or null when it can (or is
 * empty). Deliberately loose: new models come out faster than releases, so only
 * names that cannot work through the endpoint images.js calls are refused — a
 * chat model, DALL·E (which takes none of the options sent), and Imagen (which
 * Gemini serves from a different method than generateContent).
 */
function imageModelError(service, value) {
    if (value === undefined || value === null || value === '') return null;
    const label = service === 'openai' ? 'OpenAI' : 'Gemini';
    if (typeof value !== 'string' || value.length > MAX_MODEL_CHARS || !/^[\w.:/-]+$/.test(value)) {
        return `The ${label} image model must be a model name of at most ${MAX_MODEL_CHARS} characters`;
    }
    if (service === 'openai') {
        if (/dall-?e/i.test(value)) return 'DALL·E is not supported; use a gpt-image model such as gpt-image-1 or gpt-image-1-mini';
        if (!/image/i.test(value)) return `"${value}" is not an OpenAI image model; use one such as gpt-image-1 or gpt-image-1-mini`;
    } else {
        if (/^(models\/)?imagen/i.test(value)) return 'Imagen is not supported; use a Gemini image model such as gemini-2.5-flash-image';
        if (!/image/i.test(value)) return `"${value}" is not a Gemini image model; use one such as gemini-2.5-flash-image`;
    }
    return null;
}

module.exports = { IMAGE_SERVICES, DEFAULT_IMAGE_MODELS, operatorImageModel, imageModelError };
