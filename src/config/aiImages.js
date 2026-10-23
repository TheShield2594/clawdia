'use strict';

/**
 * Which service draws a guild's images, and with which model (#1229). Shared
 * by the Guild schema, the settings endpoint, the dashboard and
 * services/ai/images.js, so the enum, the validator and the behaviour cannot
 * disagree.
 *
 *   auto        follow the chat provider: Gemini for a guild on Gemini,
 *               OpenRouter for a guild on OpenRouter, otherwise OpenAI (the
 *               way voice chooses)
 *   openai      OpenAI first
 *   gemini      Gemini first
 *   openrouter  OpenRouter first, with the guild's OpenRouter key
 *   higgsfield  Higgsfield first, with the guild's Higgsfield key
 *
 * Whichever goes first, every other service the guild has a key for is tried
 * after it, in IMAGE_SERVICE_ORDER, when it fails.
 *
 * The model fields are per service because a guild can fall back from one to
 * another, and one name cannot be right for all of them. Empty means the
 * default: for OpenAI and Gemini the operator's OPENAI_IMAGE_MODEL /
 * GEMINI_IMAGE_MODEL, then the built-in one.
 */
const IMAGE_SERVICES = ['auto', 'openai', 'gemini', 'openrouter', 'higgsfield'];

/** Every service that draws, in the order they back each other up. */
const IMAGE_SERVICE_ORDER = ['openai', 'gemini', 'openrouter', 'higgsfield'];

const IMAGE_SERVICE_LABELS = { openai: 'OpenAI', gemini: 'Gemini', openrouter: 'OpenRouter', higgsfield: 'Higgsfield' };

const DEFAULT_IMAGE_MODELS = {
    openai: 'gpt-image-1',
    gemini: 'gemini-2.5-flash-image',
    // An OpenRouter model slug, served from its /api/v1/images endpoint.
    openrouter: 'google/gemini-2.5-flash-image',
    // A Higgsfield endpoint ID: the path the request is posted to.
    higgsfield: 'higgsfield-ai/soul/v2/standard'
};

const MAX_MODEL_CHARS = 100;

/**
 * The model a guild that has not picked one draws with on `service`. For OpenAI
 * and Gemini that is the operator's OPENAI_IMAGE_MODEL / GEMINI_IMAGE_MODEL,
 * else the built-in default. Read here rather than in images.js so the
 * dashboard can show it as the placeholder without loading the AI services.
 */
function operatorImageModel(service) {
    let env = '';
    if (service === 'openai') env = process.env.OPENAI_IMAGE_MODEL;
    else if (service === 'gemini') env = process.env.GEMINI_IMAGE_MODEL;
    return (env || '').trim() || DEFAULT_IMAGE_MODELS[service];
}

/**
 * Why `value` cannot be this service's image model, or null when it can (or is
 * empty). Deliberately loose: new models come out faster than releases, so only
 * names that cannot work through the endpoint images.js calls are refused — a
 * chat model, DALL·E (which takes none of the options sent), Imagen (which
 * Gemini serves from a different method than generateContent), an OpenRouter
 * name that is not an `author/model` slug, and a Higgsfield endpoint ID that is
 * not a plain path. That last one goes into the request URL, so it is held to
 * path segments of letters, digits, dots, underscores and hyphens, none of them
 * `.` or `..`.
 */
function imageModelError(service, value) {
    if (value === undefined || value === null || value === '') return null;
    const label = IMAGE_SERVICE_LABELS[service] || service;
    if (typeof value !== 'string' || value.length > MAX_MODEL_CHARS || !/^[\w.:/-]+$/.test(value)) {
        return `The ${label} image model must be a model name of at most ${MAX_MODEL_CHARS} characters`;
    }
    if (service === 'openai') {
        if (/dall-?e/i.test(value)) return 'DALL·E is not supported; use a gpt-image model such as gpt-image-1 or gpt-image-1-mini';
        if (!/image/i.test(value)) return `"${value}" is not an OpenAI image model; use one such as gpt-image-1 or gpt-image-1-mini`;
    } else if (service === 'gemini') {
        if (/^(models\/)?imagen/i.test(value)) return 'Imagen is not supported; use a Gemini image model such as gemini-2.5-flash-image';
        if (!/image/i.test(value)) return `"${value}" is not a Gemini image model; use one such as gemini-2.5-flash-image`;
    } else if (service === 'openrouter') {
        if (!/^[\w.-]+\/[\w.:-]+$/.test(value)) {
            return `"${value}" is not an OpenRouter model ID; use an author/model slug such as google/gemini-2.5-flash-image`;
        }
    } else if (service === 'higgsfield') {
        const segments = value.split('/');
        if (segments.length < 2 || segments.some(s => !/^[\w.-]+$/.test(s) || s === '.' || s === '..')) {
            return `"${value}" is not a Higgsfield endpoint ID; use one such as higgsfield-ai/soul/v2/standard`;
        }
    } else {
        return `There is no "${service}" image service`;
    }
    return null;
}

/**
 * Why `value` cannot be a Higgsfield credential, or null when it can (or is
 * empty). Higgsfield issues a key ID and a secret, and authenticates with both
 * as `Key {id}:{secret}`, so the dashboard takes them as that one string.
 */
function higgsfieldKeyError(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 512 || !/^[^\s:]+:[^\s:]+$/.test(value.trim())) {
        return 'The Higgsfield key must be your key ID and secret joined by a colon, as KEY_ID:KEY_SECRET';
    }
    return null;
}

module.exports = {
    IMAGE_SERVICES,
    IMAGE_SERVICE_ORDER,
    IMAGE_SERVICE_LABELS,
    DEFAULT_IMAGE_MODELS,
    operatorImageModel,
    imageModelError,
    higgsfieldKeyError
};
