'use strict';

const { resolveApiKey } = require('./apiKeys');
const { recordUsage } = require('./usage');
const { enforceMonthlyBudget, budgetRefusal, reserveImageLimit, refundImageLimit, IMAGES_PER_WINDOW } = require('./rateLimit');
const { randomUUID } = require('crypto');
const { setTimeout: sleep } = require('timers/promises');
const { BOT_SERVER } = require('./botTools');
const { IMAGE_SERVICE_ORDER, operatorImageModel, imageModelError } = require('../../config/aiImages');
const { request, discardBody, readCapped, readCappedText } = require('../../utils/httpFetch');
const { assertHttpsUrl, guardedDispatcher } = require('../../utils/outboundGuard');

/**
 * A `generate_image` tool (#1229): "draw a logo for the guild", "make a banner
 * for Friday's event", and the picture is posted in the conversation.
 *
 * Who draws is the guild's `ai.imageService` (config/aiImages.js): OpenAI,
 * Gemini, OpenRouter or Higgsfield, each with the guild's own key for it. Left
 * on auto it follows the rule transcription.js and speech.js use: Gemini for a
 * guild on Gemini, OpenRouter for one on OpenRouter, otherwise OpenAI. Picking
 * a service only puts it first: every other one the guild has a key for still
 * answers when it fails, and a guild with none of the keys is not offered the
 * tool. The model is the guild's own `ai.imageModels.<service>` when set.
 *
 * One image costs far more than a chat reply, so three things bound it on top
 * of the turn's ordinary tool budget: the monthly ceiling (the call is recorded
 * in the usage ledger like any other, and refused once the guild is out), an
 * hourly allowance of its own per person (and per guild for scheduled runs),
 * and at most two images in one turn.
 *
 * The bytes go where an MCP tool's images go: offered to the turn's activity,
 * which posts them after the reply. The model is only told what happened.
 */

// Most a turn may draw. A reply carries four files at most, and "make me ten
// logos" is ten charges for one question.
const MAX_IMAGES_PER_TURN = 2;
const MAX_PROMPT_CHARS = 2000;
// Below this much of the turn left, a request is refused rather than started:
// an image takes tens of seconds, and one that lands after the reply has gone
// is paid for and never posted.
const MIN_TIME_LEFT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 120_000;

const SIZES = ['square', 'landscape', 'portrait'];

// The default for a guild that has not picked a model on the dashboard.
// Overridable because both lines get new models and renames faster than
// releases; an operator should be able to follow one without waiting.
const OPENAI_IMAGE_MODEL = operatorImageModel('openai');
const GEMINI_IMAGE_MODEL = operatorImageModel('gemini');

/** The model this guild draws with on `service`: its own pick, else the default. */
function imageModelFor(aiSettings, service) {
    const own = aiSettings?.imageModels?.[service];
    if (typeof own === 'string' && own.trim()) return own.trim();
    if (service === 'openai') return OPENAI_IMAGE_MODEL;
    if (service === 'gemini') return GEMINI_IMAGE_MODEL;
    return operatorImageModel(service);
}
// Medium is about four US cents a square image on gpt-image-1; high is four
// times that, for a picture posted in a chat.
const OPENAI_IMAGE_QUALITY = 'medium';

const OPENAI_SIZE = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' };
// OpenRouter and Higgsfield take the same ratios Gemini does.
const ASPECT = { square: '1:1', landscape: '16:9', portrait: '9:16' };
const GEMINI_ASPECT = ASPECT;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images';
const HIGGSFIELD_API = 'https://api.higgsfield.ai';
// A base64 image in a JSON answer, or the file Higgsfield links to. Discord's
// own attachment limit is well under either.
const MAX_IMAGE_RESPONSE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;
// Higgsfield's own advice: start at two seconds and back off to ten.
const HIGGSFIELD_POLL_MS = 2_000;
const HIGGSFIELD_MAX_POLL_MS = 10_000;
const HIGGSFIELD_TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);

/** What an image's first bytes say it is, for a service that did not say. */
function sniffImageType(buffer) {
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

/** A JSON body, read with a cap, or null when it is not JSON. */
async function readJson(response, limit) {
    const text = await readCappedText(response, limit);
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** The sentence an error body carries, wherever this service puts it. */
function errorDetail(body) {
    const detail = body?.error?.message ?? body?.error ?? body?.detail ?? body?.message;
    if (typeof detail === 'string') return detail.slice(0, 300);
    if (detail) return JSON.stringify(detail).slice(0, 300);
    return 'no detail';
}

// How OpenRouter and Higgsfield word a prompt their moderation turned away.
// Both pass on what the provider behind them said, so this is the wording, not
// a code.
const REFUSAL_WORDING = /moderat|flagged|nsfw|safety|content.?policy|prohibited/i;

// Why Gemini stops without an image when it is the content, not the service.
const GEMINI_REFUSALS = new Set([
    'SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'
]);

/**
 * Whether an OpenAI error is its moderation saying no. The images endpoint
 * answers a refused prompt with a 400 whose code is `moderation_blocked`; older
 * responses only said so in the message.
 */
function isOpenaiRefusal(err) {
    const code = err?.code || err?.error?.code;
    if (code === 'moderation_blocked' || code === 'content_policy_violation') return true;
    return Number(err?.status) === 400 && /safety system|moderation|content policy/i.test(String(err?.message || ''));
}

function openaiUsage(result) {
    const usage = result?.usage;
    if (!usage) return null;
    return { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
}

// Each `generate(prompt, size, { signal })` resolves `{ image, mimeType, ledger }`
// for a picture or `{ refused: true, ledger }` for a prompt the service would
// not draw, and throws for anything else (an outage, a bad key).

function openaiGenerator(aiSettings, guildId) {
    const { apiKey, keySource } = resolveApiKey(aiSettings, { field: 'openaiKey', envKey: process.env.OPENAI_API_KEY, guildId });
    if (!apiKey) return null;
    const model = imageModelFor(aiSettings, 'openai');
    return {
        name: 'OpenAI',
        keySource,
        async generate(prompt, size, { signal } = {}) {
            const { OpenAI } = require('openai');
            const client = new OpenAI({ apiKey, timeout: IMAGE_TIMEOUT_MS, maxRetries: 0 });
            let result;
            try {
                result = await client.images.generate({
                    model,
                    prompt,
                    n: 1,
                    size: OPENAI_SIZE[size] || OPENAI_SIZE.square,
                    quality: OPENAI_IMAGE_QUALITY,
                    output_format: 'png'
                }, { signal });
            } catch (err) {
                // A refused prompt is not billed, so there is nothing to record.
                if (isOpenaiRefusal(err)) return { refused: true, ledger: null };
                throw err;
            }
            const ledger = { provider: 'openai', model, usage: openaiUsage(result) };
            const data = result?.data?.[0]?.b64_json;
            if (!data) throw Object.assign(new Error('no image in the response'), { ledger });
            return { image: Buffer.from(data, 'base64'), mimeType: 'image/png', ledger };
        }
    };
}

function geminiGenerator(aiSettings, guildId) {
    const { apiKey, keySource } = resolveApiKey(aiSettings, { field: 'geminiKey', envKey: process.env.GEMINI_API_KEY, guildId });
    if (!apiKey) return null;
    const model = imageModelFor(aiSettings, 'gemini');
    return {
        name: 'Gemini',
        keySource,
        async generate(prompt, size, { signal } = {}) {
            const { GoogleGenAI } = require('@google/genai');
            const client = new GoogleGenAI({ apiKey });
            const response = await client.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                    responseModalities: ['IMAGE'],
                    imageConfig: { aspectRatio: GEMINI_ASPECT[size] || GEMINI_ASPECT.square },
                    abortSignal: signal
                }
            });
            const meta = response?.usageMetadata;
            // Billed whether or not a picture came back: the prompt was read.
            const ledger = {
                provider: 'gemini',
                model,
                usage: meta ? { inputTokens: meta.promptTokenCount || 0, outputTokens: meta.candidatesTokenCount || 0 } : null
            };
            if (response?.promptFeedback?.blockReason) return { refused: true, ledger };
            const candidate = response?.candidates?.[0];
            const inline = candidate?.content?.parts?.find(part => part?.inlineData?.data)?.inlineData;
            if (inline && EXTENSIONS[inline.mimeType]) {
                return { image: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType, ledger };
            }
            if (GEMINI_REFUSALS.has(candidate?.finishReason)) return { refused: true, ledger };
            throw Object.assign(new Error(`no image in the response (${candidate?.finishReason || 'no reason given'})`), { ledger });
        }
    };
}

function openrouterUsage(body) {
    const usage = body?.usage;
    if (!usage) return null;
    const cost = Number(usage.cost);
    return {
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        // What OpenRouter charged, in USD: the one price there is for a model
        // the ledger has no table for.
        cost: Number.isFinite(cost) && cost >= 0 ? cost : null
    };
}

// OpenRouter's dedicated image endpoint: one request, the picture in the
// answer as base64. A generation that does not finish comes back as an error
// and is not billed.
function openrouterGenerator(aiSettings, guildId) {
    const { apiKey, keySource } = resolveApiKey(aiSettings, { field: 'openrouterKey', envKey: process.env.OPENROUTER_API_KEY, guildId });
    if (!apiKey) return null;
    const model = imageModelFor(aiSettings, 'openrouter');
    return {
        name: 'OpenRouter',
        keySource,
        async generate(prompt, size, { signal } = {}) {
            const response = await request(OPENROUTER_IMAGES_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://github.com/TheShield2594/clawdia',
                    'X-Title': 'Clawdia'
                },
                // Medium for the same reason as on OpenAI; a model with no
                // quality setting ignores it.
                body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: ASPECT[size] || ASPECT.square, quality: OPENAI_IMAGE_QUALITY }),
                signal
            });
            const body = await readJson(response, MAX_IMAGE_RESPONSE_BYTES);
            if (!response.ok) {
                const detail = errorDetail(body);
                if ([400, 403].includes(response.status) && REFUSAL_WORDING.test(`${detail} ${body?.error?.code || ''}`)) {
                    return { refused: true, ledger: null };
                }
                throw new Error(`OpenRouter answered ${response.status}: ${detail}`);
            }
            const ledger = { provider: 'openrouter', model, usage: openrouterUsage(body) };
            const item = body?.data?.[0];
            if (!item?.b64_json) throw Object.assign(new Error('no image in the response'), { ledger });
            const image = Buffer.from(item.b64_json, 'base64');
            const mimeType = EXTENSIONS[item.media_type] ? item.media_type : sniffImageType(image);
            if (!mimeType) throw Object.assign(new Error(`unsupported image type (${item.media_type || 'unknown'})`), { ledger });
            return { image, mimeType, ledger };
        }
    };
}

// Higgsfield is asynchronous: the request is submitted, then its status polled
// until it finishes, and a finished one links to the picture rather than
// carrying it. Only a completed request is charged; failed and NSFW ones are
// refunded. Its answers carry no usage, so the price is asked for first, from
// its estimate endpoint, and recorded once the picture is made.
function higgsfieldGenerator(aiSettings, guildId, { pollMs = HIGGSFIELD_POLL_MS } = {}) {
    const { apiKey } = resolveApiKey(aiSettings, { field: 'higgsfieldKey', guildId });
    if (!apiKey) return null;
    const model = imageModelFor(aiSettings, 'higgsfield');
    return {
        name: 'Higgsfield',
        async generate(prompt, size, { signal } = {}) {
            // The endpoint ID goes into the URL. The settings endpoint checks it
            // on the way in; this is the same check where it is used.
            const invalid = imageModelError('higgsfield', model);
            if (invalid) throw new Error(invalid);
            const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
            const input = JSON.stringify({ prompt, aspect_ratio: ASPECT[size] || ASPECT.square });

            let cost = null;
            try {
                const estimate = await request(`${HIGGSFIELD_API}/estimate/${model}`, { method: 'POST', headers, body: input, signal });
                if (estimate.ok) {
                    const usd = Number((await readJson(estimate, MAX_STATUS_BYTES))?.usd);
                    if (Number.isFinite(usd) && usd >= 0) cost = usd;
                } else {
                    await discardBody(estimate);
                }
            } catch (err) {
                // An estimate is worth having, not worth failing the picture over.
                if (signal?.aborted) throw err;
            }

            const submitted = await request(`${HIGGSFIELD_API}/${model}`, {
                method: 'POST',
                headers: { ...headers, 'Idempotency-Key': randomUUID() },
                body: input,
                signal
            });
            let state = await readJson(submitted, MAX_STATUS_BYTES);
            if (!submitted.ok) {
                const detail = errorDetail(state);
                if (submitted.status === 400 && REFUSAL_WORDING.test(detail)) return { refused: true, ledger: null };
                throw new Error(`Higgsfield answered ${submitted.status}: ${detail}`);
            }
            const id = state?.request_id;
            if (typeof id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(id)) throw new Error('Higgsfield returned no request ID');

            let delay = pollMs;
            try {
                while (!HIGGSFIELD_TERMINAL.has(state?.status)) {
                    await sleep(delay, undefined, { signal });
                    delay = Math.min(Math.round(delay * 1.5), HIGGSFIELD_MAX_POLL_MS);
                    const polled = await request(`${HIGGSFIELD_API}/requests/${id}/status`, { headers, signal });
                    if (polled.status >= 500) {
                        await discardBody(polled);
                        continue;
                    }
                    const body = await readJson(polled, MAX_STATUS_BYTES);
                    if (!polled.ok) throw new Error(`Higgsfield answered ${polled.status}: ${errorDetail(body)}`);
                    state = body;
                }
            } catch (err) {
                // Out of time: a request still queued can be called off, and a
                // cancelled one is refunded. One that has started cannot, and
                // is paid for whether or not anyone sees it.
                if (signal?.aborted) {
                    request(`${HIGGSFIELD_API}/requests/${id}/cancel`, { method: 'POST', headers, timeout: 5_000 })
                        .then(discardBody, () => {});
                }
                throw err;
            }

            if (state.status === 'nsfw') return { refused: true, ledger: null };
            if (state.status !== 'completed') {
                throw new Error(`Higgsfield request ${state.status}${state.error ? `: ${errorDetail(state)}` : ''}`);
            }
            const ledger = { provider: 'higgsfield', model, usage: { inputTokens: 0, outputTokens: 0, cost } };
            const url = state.images?.[0]?.url;
            if (typeof url !== 'string') throw Object.assign(new Error('no image in the response'), { ledger });

            let image;
            let mimeType;
            try {
                // Somebody else's link, fetched from here: https, and through the
                // dispatcher that will not dial a private address.
                const file = await request(assertHttpsUrl(url, 'The image link').href, { dispatcher: guardedDispatcher(), signal });
                if (!file.ok) {
                    await discardBody(file);
                    throw new Error(`the image link answered ${file.status}`);
                }
                image = await readCapped(file, MAX_IMAGE_FILE_BYTES);
                const declared = String(file.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
                mimeType = EXTENSIONS[declared] ? declared : sniffImageType(image);
            } catch (err) {
                throw Object.assign(err, { ledger });
            }
            if (!mimeType) throw Object.assign(new Error('the image link was not a PNG, JPEG or WebP'), { ledger });
            return { image, mimeType, ledger };
        }
    };
}

const GENERATORS = {
    openai: openaiGenerator,
    gemini: geminiGenerator,
    openrouter: openrouterGenerator,
    higgsfield: higgsfieldGenerator
};

/** The service that goes first: the guild's pick, or on auto its chat provider's. */
function firstImageService(aiSettings) {
    const picked = aiSettings?.imageService;
    if (GENERATORS[picked]) return picked;
    const provider = aiSettings?.provider;
    return provider === 'gemini' || provider === 'openrouter' ? provider : 'openai';
}

/** Every service this guild has a key for, in the order to try them. */
function imageGeneratorsFor(aiSettings, guildId) {
    const first = firstImageService(aiSettings);
    const order = [first, ...IMAGE_SERVICE_ORDER.filter(service => service !== first)];
    return order.map(service => GENERATORS[service](aiSettings || {}, guildId)).filter(Boolean);
}

// Discord caps an attachment description at 1,024 characters.
function altText(prompt) {
    const text = `Generated image: ${prompt}`;
    return text.length > 1024 ? `${text.slice(0, 1023)}…` : text;
}

/**
 * Draw one image and offer it to the conversation.
 *
 * Never throws: every outcome, a refusal included, is a sentence the model can
 * relay, because the caller is a chat reply and "I can't draw that" is an answer.
 *
 * @param {object} args the model's `{ prompt, size }`
 * @param {object} context
 * @param {string} context.guildId
 * @param {?string} context.userId whose hourly allowance; null for a scheduled run
 * @param {?object} context.rateLimit the guild's limits, for the monthly ceiling
 * @param {object[]} context.generators from imageGeneratorsFor
 * @param {{count: number, pending: number}} context.turn images drawn so far
 *   this turn, and those being drawn right now
 * @param {object} runContext what the toolkit hands a bot tool
 * @param {Function} runContext.attach offers a file; true when it will be posted
 * @param {number} [runContext.deadline] when the turn stops waiting, in ms
 */
async function generateImage(args, { guildId, userId = null, rateLimit = null, generators, turn, record = recordUsage }, { attach, deadline } = {}) {
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim().slice(0, MAX_PROMPT_CHARS) : '';
    if (!prompt) return 'No image was made: the prompt was empty.';
    const size = SIZES.includes(args?.size) ? args.size : 'square';

    if (typeof attach !== 'function') return 'No image was made: this conversation cannot take a file.';
    // Counting the ones still being drawn: a model that asks for three in one
    // round runs all three at once, before any of them has finished.
    if (turn.count + (turn.pending || 0) >= MAX_IMAGES_PER_TURN) {
        return `No image was made: one reply can carry at most ${MAX_IMAGES_PER_TURN} generated images. Tell the user to ask again for more.`;
    }
    try {
        if (rateLimit) enforceMonthlyBudget(guildId, rateLimit);
    } catch (err) {
        if (err?.name === 'AiBudgetError') return `No image was made: ${err.message}`;
        throw err;
    }
    const timeLeft = Number.isFinite(deadline) ? deadline - Date.now() : IMAGE_TIMEOUT_MS;
    if (timeLeft < MIN_TIME_LEFT_MS) {
        return 'No image was made: this reply does not have enough time left to draw one. Tell the user to ask for it on its own.';
    }

    // Held now, before the slow call, for the same reason as the turn count
    // above: calls in one round are concurrent, and a check made after the
    // service answered would let all of them through.
    const reservation = reserveImageLimit(guildId, userId);
    if (!reservation) {
        return userId
            ? `No image was made: this person has used their ${IMAGES_PER_WINDOW} images for this hour. Tell them to try again later.`
            : `No image was made: this server's scheduled tasks have used their ${IMAGES_PER_WINDOW} images for this hour.`;
    }
    turn.pending = (turn.pending || 0) + 1;
    // Whether any service answered, refusal or picture. Either can be billed,
    // so the hour's slot is kept; it is given back only when every service
    // failed before answering.
    let answered = false;

    const recordLedger = ledger => {
        if (!ledger?.usage) return;
        Promise.resolve()
            .then(() => record(guildId, ledger.provider, ledger.model, ledger.usage))
            .catch(err => console.warn(`[AI:image] could not record image usage: ${err.message}`));
    };

    // The operator's ceiling, when the only services that could draw this are
    // on the operator's key and it has been reached.
    let refusedFor = null;

    try {
        for (const generator of generators) {
            const refusal = budgetRefusal(guildId, rateLimit, generator.keySource);
            if (refusal) {
                refusedFor = refusal;
                continue;
            }
            let made;
            try {
                made = await generator.generate(prompt, size, { signal: AbortSignal.timeout(Math.min(IMAGE_TIMEOUT_MS, timeLeft - 1000)) });
            } catch (err) {
                // A call that reached the service and failed after may still be billed.
                recordLedger(err?.ledger);
                console.warn(`[AI:image] ${generator.name} image generation failed: ${err.message}`);
                continue;
            }
            recordLedger(made?.ledger);
            answered = true;

            if (made?.refused) {
                // Not tried on the other service: a refusal is about the prompt, and
                // shopping it around is exactly what moderation is there to stop.
                return `The image service refused that prompt as against its content rules, so no image was made. `
                    + 'Tell the user plainly, without quoting the rules, and offer to try a different idea.';
            }

            turn.count += 1;
            const name = `generated-image-${turn.count}.${EXTENSIONS[made.mimeType] || 'png'}`;
            const posted = attach({ buffer: made.image, name, mimeType: made.mimeType, description: altText(prompt) }) === true;
            if (!posted) {
                return 'The image was made, but this reply cannot carry any more files, so it was not posted. Tell the user.';
            }
            return `The image was made and will be posted in the conversation, after your reply, as ${name}. `
                + 'Do not describe it as a link or paste anything for it; refer to it as the image below, briefly.';
        }
        if (refusedFor && !answered) return `No image was made: ${refusedFor}`;
        return 'The image could not be made: the image service failed. Tell the user it did not work and they can try again later.';
    } finally {
        turn.pending -= 1;
        if (!answered) refundImageLimit(reservation);
    }
}

function generateImageTool(context) {
    const turn = { count: 0, pending: 0 };
    return {
        name: 'generate_image',
        serverName: BOT_SERVER,
        toolName: 'generate_image',
        description: 'Draw an image from a text description and post it in the conversation — a logo, a banner, an '
            + 'illustration, a meme. Only when someone asks for a picture to be made. Write the prompt as a full '
            + 'description of the picture: subject, style, colours, composition and any text it should contain.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', maxLength: MAX_PROMPT_CHARS, description: 'A full description of the image to draw.' },
                size: { type: 'string', enum: SIZES, description: 'Shape of the image. Square unless a banner (landscape) or a poster or phone wallpaper (portrait) is wanted.' }
            },
            required: ['prompt']
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        // It posts a picture and changes nothing else, so it is no more an action
        // than the reply it rides on.
        confirm: false,
        run: (args, runContext) => generateImage(args, { ...context, turn }, runContext)
    };
}

module.exports = {
    generateImageTool,
    generateImage,
    imageGeneratorsFor,
    imageModelFor,
    higgsfieldGenerator,
    sniffImageType,
    isOpenaiRefusal,
    MAX_IMAGES_PER_TURN,
    OPENAI_IMAGE_MODEL,
    GEMINI_IMAGE_MODEL
};
