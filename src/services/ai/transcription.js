'use strict';

const { guardedDispatcher, assertPublicHttpUrl } = require('../../utils/outboundGuard');
const { request, discardBody, readCapped } = require('../../utils/httpFetch');
const { resolveApiKey } = require('./apiKeys');
const { recordUsage } = require('./usage');
const { enforceMonthlyBudget } = require('./rateLimit');

/**
 * Voice messages, turned into words before the model sees them.
 *
 * On a phone, holding the mic button is how most people talk to an assistant,
 * and a Discord voice message reaches the bot as an audio attachment with no
 * text at all. Without this the model is handed "[an attachment]" and answers
 * nothing. With it, the transcript becomes the user's turn: the model answers
 * it, the history keeps it, and memory and search see it like typed text.
 *
 * Which service does the listening is decided by the keys the guild already
 * has, not a new setting: Gemini when the guild runs on Gemini, otherwise
 * OpenAI's transcription model, otherwise Gemini again. Claude, OpenRouter and
 * Ollama take no audio, so a guild on one of those transcribes with whichever
 * of the two keys it has — or is told it has neither.
 */

// Every format Discord produces for a voice message or an uploaded clip that
// both services accept.
const AUDIO_MIME_TYPES = new Set([
    'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/flac', 'audio/aac'
]);
const EXTENSION_MIME = {
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    wav: 'audio/wav', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac'
};

// Under both services' upload ceilings (OpenAI 25 MB, Gemini inline 20 MB). A
// voice message is a few hundred kilobytes a minute; this is a long recording.
const MAX_AUDIO_BYTES = 19 * 1024 * 1024;
// Ten minutes of talking is a memo. Longer is a meeting recording, and every
// second of it is billed whether or not the answer needed it.
const MAX_AUDIO_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
// A transcript is the user's turn, and a turn has a budget like any other.
const MAX_TRANSCRIPT_CHARS = 8000;

const OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
// The model Google's own audio-understanding guide uses. The 2.5 models are
// limited to projects that already used them, so a key made today could not
// call one.
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.8-flash';
// The name a Gemini transcription goes into the usage ledger under. Gemini
// bills audio input well above the text rate of the same model, so it gets a
// pricing row of its own (providers/gemini.js) rather than being priced as if
// the clip had been typed.
const GEMINI_TRANSCRIBE_LEDGER_MODEL = `${GEMINI_TRANSCRIBE_MODEL} (audio)`;

// What each service accepts, by the MIME type the clip arrives as. OpenAI's
// transcription endpoint takes flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav and
// webm — not raw AAC or a bare .opus file. Gemini takes those and more, but
// names some of them differently, so a clip is relabelled for it.
const OPENAI_FORMATS = new Set([
    'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/flac'
]);
const GEMINI_MIME = {
    'audio/ogg': 'audio/ogg', 'audio/opus': 'audio/opus', 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mp3',
    'audio/mp4': 'audio/m4a', 'audio/m4a': 'audio/m4a', 'audio/x-m4a': 'audio/m4a',
    'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
    'audio/webm': 'audio/webm', 'audio/flac': 'audio/flac', 'audio/aac': 'audio/aac'
};

function audioMimeType(attachment) {
    const declared = String(attachment?.contentType || '').split(';')[0].trim().toLowerCase();
    if (AUDIO_MIME_TYPES.has(declared)) return declared;
    if (declared && !declared.startsWith('application/octet-stream')) return null;
    const ext = String(attachment?.name || '').toLowerCase().split('.').pop();
    return EXTENSION_MIME[ext] || null;
}

/**
 * The one audio clip on a message worth transcribing, if any.
 *
 * One, not all: a voice message is always a single clip, and a message with
 * several audio files is somebody sharing recordings rather than talking.
 *
 * @returns {{clip: ?object, refused: ?string}} `refused` says why a clip that
 *   was there will not be transcribed
 */
function collectVoice(message) {
    const all = message?.attachments;
    const list = all ? (typeof all.values === 'function' ? [...all.values()] : [...all]) : [];
    const attachment = list.find(item => audioMimeType(item) && item?.url);
    if (!attachment) return { clip: null, refused: null };

    const size = Number(attachment.size) || 0;
    const seconds = Number(attachment.duration);
    if (size > MAX_AUDIO_BYTES) return { clip: null, refused: 'it is too large to transcribe' };
    if (Number.isFinite(seconds) && seconds > MAX_AUDIO_SECONDS) {
        return { clip: null, refused: `it is longer than ${MAX_AUDIO_SECONDS / 60} minutes` };
    }
    return {
        clip: {
            url: attachment.url,
            name: attachment.name || 'voice-message.ogg',
            mimeType: audioMimeType(attachment),
            size,
            seconds: Number.isFinite(seconds) ? seconds : null
        },
        refused: null
    };
}

/**
 * What an OpenAI transcription cost, in the ledger's shape. The `gpt-4o-*-
 * transcribe` models report tokens (`{ type: 'tokens', input_tokens, ... }`);
 * whisper reports seconds instead, which this module never calls, so anything
 * other than tokens is nothing to record.
 */
function openaiTranscriptionUsage(result) {
    const usage = result && typeof result === 'object' ? result.usage : null;
    if (!usage || (usage.type && usage.type !== 'tokens')) return null;
    return { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
}

/** What a Gemini `generateContent` call cost, from its `usageMetadata`. */
function geminiUsage(response) {
    const meta = response?.usageMetadata;
    if (!meta) return null;
    return { inputTokens: meta.promptTokenCount || 0, outputTokens: meta.candidatesTokenCount || 0 };
}

function openaiTranscriber(aiSettings, guildId) {
    const { apiKey } = resolveApiKey(aiSettings, { field: 'openaiKey', envKey: process.env.OPENAI_API_KEY, guildId });
    if (!apiKey) return null;
    return {
        name: 'OpenAI',
        accepts: clip => OPENAI_FORMATS.has(clip.mimeType),
        async transcribe(buffer, clip) {
            const { OpenAI, toFile } = require('openai');
            const client = new OpenAI({ apiKey, timeout: TRANSCRIBE_TIMEOUT_MS });
            const file = await toFile(buffer, clip.name, { type: clip.mimeType });
            const result = await client.audio.transcriptions.create({ file, model: OPENAI_TRANSCRIBE_MODEL });
            return {
                text: typeof result === 'string' ? result : result?.text,
                ledger: { provider: 'openai', model: OPENAI_TRANSCRIBE_MODEL, usage: openaiTranscriptionUsage(result) }
            };
        }
    };
}

function geminiTranscriber(aiSettings, guildId) {
    const { apiKey } = resolveApiKey(aiSettings, { field: 'geminiKey', envKey: process.env.GEMINI_API_KEY, guildId });
    if (!apiKey) return null;
    return {
        name: 'Gemini',
        accepts: clip => Boolean(GEMINI_MIME[clip.mimeType]),
        async transcribe(buffer, clip) {
            const { GoogleGenAI } = require('@google/genai');
            const client = new GoogleGenAI({ apiKey });
            const response = await client.models.generateContent({
                model: GEMINI_TRANSCRIBE_MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: GEMINI_MIME[clip.mimeType], data: buffer.toString('base64') } },
                        { text: 'Transcribe this voice message word for word, in the language it is spoken in. '
                            + 'Reply with the transcript only — no preamble, no notes. If nothing intelligible is said, reply with nothing.' }
                    ]
                }],
                config: { temperature: 0, abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) }
            });
            return {
                text: response?.text,
                ledger: { provider: 'gemini', model: GEMINI_TRANSCRIBE_LEDGER_MODEL, usage: geminiUsage(response) }
            };
        }
    };
}

/**
 * Every service this guild has a key for, in the order to try them: Gemini
 * first for a guild on Gemini, OpenAI first otherwise.
 */
function transcribersFor(aiSettings, guildId) {
    const order = aiSettings?.provider === 'gemini'
        ? [geminiTranscriber, openaiTranscriber]
        : [openaiTranscriber, geminiTranscriber];
    return order.map(make => make(aiSettings || {}, guildId)).filter(Boolean);
}

/** The first service that would be tried, or null with no key for either. */
function transcriberFor(aiSettings, guildId) {
    return transcribersFor(aiSettings, guildId)[0] || null;
}

async function downloadClip(clip, { requestImpl = request } = {}) {
    // A Discord CDN URL in practice, but it arrives on a message and is
    // treated like any other address somebody else chose.
    assertPublicHttpUrl(clip.url, 'attachment URL');
    const response = await requestImpl(clip.url, { timeout: FETCH_TIMEOUT_MS, dispatcher: guardedDispatcher() });
    if (!response.ok) {
        await discardBody(response);
        throw new Error(`HTTP ${response.status}`);
    }
    return readCapped(response, MAX_AUDIO_BYTES);
}

/**
 * Turn a clip into text.
 *
 * Never throws: a failure is `{ error }` in words fit to show the user, because
 * the caller is a chat reply and "I could not hear that" is an answer.
 *
 * @returns {Promise<{text?: string, service?: string, error?: string}>}
 */
async function transcribeClip(clip, aiSettings, guildId, {
    transcribers = transcribersFor(aiSettings, guildId),
    requestImpl,
    rateLimit = null,
    record = recordUsage
} = {}) {
    if (!transcribers.length) {
        return { error: 'I cannot listen to voice messages here: this server has no OpenAI or Gemini key for transcription.' };
    }
    // A guild that is out of budget cannot have the reply, so it should not
    // pay for the transcript of the question either (#1230).
    try {
        if (rateLimit) enforceMonthlyBudget(guildId, rateLimit);
    } catch (err) {
        if (err?.name === 'AiBudgetError') return { error: err.message };
        throw err;
    }
    // Only the services that can read this format — decided before anything
    // is downloaded, so an unsupported clip costs nothing.
    const able = transcribers.filter(transcriber => !transcriber.accepts || transcriber.accepts(clip));
    if (!able.length) {
        return { error: `I cannot listen to that recording: ${clip.mimeType} is not a format this server's transcription service reads.` };
    }

    let buffer;
    try {
        buffer = await downloadClip(clip, { requestImpl });
    } catch (err) {
        console.warn(`[AI:voice] could not download ${clip.name}: ${err.message}`);
        return { error: 'I could not download that voice message. Try sending it again.' };
    }
    if (!buffer?.length) return { error: 'That voice message was empty.' };

    // Each able service in turn: a failure on one (an outage, a key without
    // access to the model) is worth one more try on the other.
    let heardNothing = false;
    for (const transcriber of able) {
        let result;
        try {
            result = await transcriber.transcribe(buffer, clip);
        } catch (err) {
            console.warn(`[AI:voice] ${transcriber.name} transcription failed: ${err.message}`);
            continue;
        }
        // A transcriber answers `{ text, ledger }`, or a bare string when it has
        // no cost to report. Recorded whether or not anything was heard: the
        // call was billed either way.
        const text = typeof result === 'string' ? result : result?.text;
        const ledger = typeof result === 'object' ? result?.ledger : null;
        if (ledger?.usage) {
            Promise.resolve()
                .then(() => record(guildId, ledger.provider, ledger.model, ledger.usage))
                .catch(err => console.warn(`[AI:voice] could not record transcription usage: ${err.message}`));
        }
        const clean = typeof text === 'string' ? text.trim() : '';
        if (!clean) {
            // Silence is an answer, not a failure: another service would hear
            // the same nothing.
            heardNothing = true;
            break;
        }
        return {
            text: clean.length > MAX_TRANSCRIPT_CHARS ? `${clean.slice(0, MAX_TRANSCRIPT_CHARS)}…` : clean,
            service: transcriber.name
        };
    }
    return heardNothing
        ? { error: 'I could not make out anything in that voice message.' }
        : { error: 'I could not transcribe that voice message. Try again, or type it.' };
}

/**
 * The user's turn for a message that had a voice clip: the transcript, marked
 * as one so the model knows it was spoken (and may contain mishearings), with
 * any typed text that came alongside it.
 */
function voiceTurn(transcript, typed = '') {
    const spoken = `[Voice message, transcribed]\n${transcript}`;
    return typed ? `${typed}\n\n${spoken}` : spoken;
}

module.exports = {
    collectVoice,
    transcribeClip,
    transcriberFor,
    transcribersFor,
    voiceTurn,
    audioMimeType,
    MAX_AUDIO_BYTES,
    MAX_AUDIO_SECONDS,
    openaiTranscriptionUsage,
    geminiUsage,
    OPENAI_TRANSCRIBE_MODEL,
    GEMINI_TRANSCRIBE_MODEL,
    GEMINI_TRANSCRIBE_LEDGER_MODEL
};
