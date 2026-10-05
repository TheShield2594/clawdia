'use strict';

const { resolveApiKey } = require('./apiKeys');
const { recordUsage } = require('./usage');
const { enforceMonthlyBudget, peekImageLimit, checkImageLimit, IMAGES_PER_WINDOW } = require('./rateLimit');
const { BOT_SERVER } = require('./botTools');

/**
 * A `generate_image` tool (#1229): "draw a logo for the guild", "make a banner
 * for Friday's event", and the picture is posted in the conversation.
 *
 * Who draws follows the rule transcription.js and speech.js use, with the keys
 * the guild already has: Gemini for a guild on Gemini, otherwise OpenAI's image
 * model, otherwise Gemini. Claude, OpenRouter and Ollama make no images, so a
 * guild on one of those draws with whichever of the two keys it has, and is not
 * offered the tool with neither.
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

// Overridable because both lines get new models and renames faster than
// releases; an operator should be able to follow one without waiting.
const OPENAI_IMAGE_MODEL = (process.env.OPENAI_IMAGE_MODEL || '').trim() || 'gpt-image-1';
const GEMINI_IMAGE_MODEL = (process.env.GEMINI_IMAGE_MODEL || '').trim() || 'gemini-2.5-flash-image';
// Medium is about four US cents a square image on gpt-image-1; high is four
// times that, for a picture posted in a chat.
const OPENAI_IMAGE_QUALITY = 'medium';

const OPENAI_SIZE = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' };
const GEMINI_ASPECT = { square: '1:1', landscape: '16:9', portrait: '9:16' };
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

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
    const { apiKey } = resolveApiKey(aiSettings, { field: 'openaiKey', envKey: process.env.OPENAI_API_KEY, guildId });
    if (!apiKey) return null;
    return {
        name: 'OpenAI',
        async generate(prompt, size, { signal } = {}) {
            const { OpenAI } = require('openai');
            const client = new OpenAI({ apiKey, timeout: IMAGE_TIMEOUT_MS, maxRetries: 0 });
            let result;
            try {
                result = await client.images.generate({
                    model: OPENAI_IMAGE_MODEL,
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
            const ledger = { provider: 'openai', model: OPENAI_IMAGE_MODEL, usage: openaiUsage(result) };
            const data = result?.data?.[0]?.b64_json;
            if (!data) throw Object.assign(new Error('no image in the response'), { ledger });
            return { image: Buffer.from(data, 'base64'), mimeType: 'image/png', ledger };
        }
    };
}

function geminiGenerator(aiSettings, guildId) {
    const { apiKey } = resolveApiKey(aiSettings, { field: 'geminiKey', envKey: process.env.GEMINI_API_KEY, guildId });
    if (!apiKey) return null;
    return {
        name: 'Gemini',
        async generate(prompt, size, { signal } = {}) {
            const { GoogleGenAI } = require('@google/genai');
            const client = new GoogleGenAI({ apiKey });
            const response = await client.models.generateContent({
                model: GEMINI_IMAGE_MODEL,
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
                model: GEMINI_IMAGE_MODEL,
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

/** Every service this guild has a key for, in the order to try them. */
function imageGeneratorsFor(aiSettings, guildId) {
    const order = aiSettings?.provider === 'gemini'
        ? [geminiGenerator, openaiGenerator]
        : [openaiGenerator, geminiGenerator];
    return order.map(make => make(aiSettings || {}, guildId)).filter(Boolean);
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
 * @param {{count: number}} context.turn images drawn so far this turn
 * @param {object} runContext what the toolkit hands a bot tool
 * @param {Function} runContext.attach offers a file; true when it will be posted
 * @param {number} [runContext.deadline] when the turn stops waiting, in ms
 */
async function generateImage(args, { guildId, userId = null, rateLimit = null, generators, turn, record = recordUsage }, { attach, deadline } = {}) {
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim().slice(0, MAX_PROMPT_CHARS) : '';
    if (!prompt) return 'No image was made: the prompt was empty.';
    const size = SIZES.includes(args?.size) ? args.size : 'square';

    if (typeof attach !== 'function') return 'No image was made: this conversation cannot take a file.';
    if (turn.count >= MAX_IMAGES_PER_TURN) {
        return `No image was made: one reply can carry at most ${MAX_IMAGES_PER_TURN} generated images. Tell the user to ask again for more.`;
    }
    try {
        if (rateLimit) enforceMonthlyBudget(guildId, rateLimit);
    } catch (err) {
        if (err?.name === 'AiBudgetError') return `No image was made: ${err.message}`;
        throw err;
    }
    if (!peekImageLimit(guildId, userId)) {
        return userId
            ? `No image was made: this person has used their ${IMAGES_PER_WINDOW} images for this hour. Tell them to try again later.`
            : `No image was made: this server's scheduled tasks have used their ${IMAGES_PER_WINDOW} images for this hour.`;
    }

    const timeLeft = Number.isFinite(deadline) ? deadline - Date.now() : IMAGE_TIMEOUT_MS;
    if (timeLeft < MIN_TIME_LEFT_MS) {
        return 'No image was made: this reply does not have enough time left to draw one. Tell the user to ask for it on its own.';
    }

    const recordLedger = ledger => {
        if (!ledger?.usage) return;
        Promise.resolve()
            .then(() => record(guildId, ledger.provider, ledger.model, ledger.usage))
            .catch(err => console.warn(`[AI:image] could not record image usage: ${err.message}`));
    };

    for (const generator of generators) {
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
        // Counted once the service has answered, refusal or picture: either can
        // be billed, and a refused prompt retried a dozen times is still a dozen.
        checkImageLimit(guildId, userId);

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
    return 'The image could not be made: the image service failed. Tell the user it did not work and they can try again later.';
}

function generateImageTool(context) {
    const turn = { count: 0 };
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
    isOpenaiRefusal,
    MAX_IMAGES_PER_TURN,
    OPENAI_IMAGE_MODEL,
    GEMINI_IMAGE_MODEL
};
