'use strict';

const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { resolveApiKey } = require('./apiKeys');
const { recordUsage } = require('./usage');
const { enforceMonthlyBudget } = require('./rateLimit');
const { VOICE_REPLY_MODES } = require('../../config/aiVoice');

/**
 * Spoken replies: the other half of voice messages (#1231).
 *
 * Somebody who talks to the bot from their phone would often rather listen to
 * the answer than read it. With `ai.voiceReplies` on, a finished reply is also
 * read aloud and posted as audio after the text. Never instead of the text:
 * the text stays the reply, searchable and readable, and the audio is a
 * convenience on top of it. So everything here fails quietly, because a reply
 * whose audio could not be made is still a complete reply.
 *
 * Who does the speaking follows the same rule as transcription.js: Gemini for
 * a guild on Gemini, otherwise OpenAI, otherwise Gemini, with whichever keys
 * the guild already has.
 */

// How much of a reply is read out. Past this the listener is told the rest is
// in the text: a two-thousand-word answer is something to read, and every
// second of audio is billed.
const MAX_SPOKEN_CHARS = 1500;
const SPEAK_TIMEOUT_MS = 60_000;

const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = 'coral';
// Overridable because Gemini's speech models are previews and get renamed;
// an operator should not need a release to follow one.
const GEMINI_TTS_MODEL = (process.env.GEMINI_TTS_MODEL || '').trim() || 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = 'Kore';

// OpenAI's own figure for gpt-4o-mini-tts is about $0.015 a minute, which at
// its $12 per million audio-output tokens is 1,250 tokens a minute. The speech
// endpoint reports no usage, so the ledger is given that estimate from the
// clip's length, and the input is estimated the way budget.js estimates text.
const OPENAI_TTS_TOKENS_PER_SECOND = 1250 / 60;
const CHARS_PER_TOKEN = 4;

// Discord draws a voice message's waveform from at most 256 one-byte samples.
const MAX_WAVEFORM_SAMPLES = 256;

/**
 * Whether this reply should also be spoken, under the guild's setting (one of
 * VOICE_REPLY_MODES). `always-in-dms` is a superset of `when-spoken-to`: a DM
 * is always answered aloud, and a voice message anywhere still is.
 */
function shouldSpeak(mode, { spokenTo = false, inDm = false } = {}) {
    if (mode === 'when-spoken-to') return spokenTo;
    if (mode === 'always-in-dms') return spokenTo || inDm;
    return false;
}

/**
 * The reply as something to read aloud: no markdown symbols, no URLs, no
 * mention tokens, no code, and no longer than MAX_SPOKEN_CHARS.
 */
function spokenText(text, max = MAX_SPOKEN_CHARS) {
    let out = String(text || '')
        .replace(/```[\s\S]*?(```|$)/g, ' (code is in the text) ')
        .replace(/\[([^\]]+)\]\((?:https?:\/\/|<)[^)]*\)/g, '$1')
        .replace(/<a?:\w+:\d+>/g, '')
        .replace(/<(?:@[!&]?|#)\d+>/g, '')
        .replace(/<?https?:\/\/\S+/g, 'a link')
        .replace(/\|\|/g, '')
        .replace(/[*_~`]+/g, '')
        .replace(/^\s*(?:#{1,6}|>{1,3}|-#)\s+/gm, '')
        .replace(/^\s*[-•]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (out.length <= max) return out;

    // Cut at the last sentence end that keeps most of it, else the last word.
    const head = out.slice(0, max);
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    const cut = sentence > max * 0.6 ? sentence + 1 : Math.max(head.lastIndexOf(' '), 1);
    out = `${head.slice(0, cut).trim()} … The rest is in the text.`;
    return out;
}

// ── Reading an Ogg Opus clip ─────────────────────────────────────────────────
//
// A Discord voice message carries its length and a waveform alongside the
// file, and the speech services return neither. Both can be read off the Ogg
// container without decoding a sample: the last page's granule position is the
// clip's length in 48 kHz samples, and how many bytes each page spends on its
// stretch of audio is a fair stand-in for how loud it is — Opus spends little
// on silence.

function oggPages(buffer) {
    const pages = [];
    let offset = 0;
    while (offset + 27 <= buffer.length) {
        if (buffer.toString('latin1', offset, offset + 4) !== 'OggS') break;
        const segments = buffer[offset + 26];
        if (offset + 27 + segments > buffer.length) break;
        let bodyLength = 0;
        for (let i = 0; i < segments; i++) bodyLength += buffer[offset + 27 + i];
        const bodyStart = offset + 27 + segments;
        pages.push({
            granule: Number(buffer.readBigInt64LE(offset + 6)),
            bodyStart,
            bodyLength
        });
        offset = bodyStart + bodyLength;
    }
    return pages;
}

/**
 * The length (seconds) and waveform (base64) of an Ogg Opus clip, or null when
 * the buffer is not one this can read.
 */
function describeOggOpus(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    const pages = oggPages(buffer);
    if (pages.length < 3) return null;
    const head = pages[0];
    if (buffer.toString('latin1', head.bodyStart, head.bodyStart + 8) !== 'OpusHead') return null;
    const preSkip = buffer.readUInt16LE(head.bodyStart + 10);

    // Pages 0 and 1 are the Opus headers; the audio starts at page 2.
    const audio = pages.slice(2).filter(page => page.granule >= 0);
    const last = audio.at(-1);
    if (!last) return null;
    const seconds = Math.max(0, (last.granule - preSkip) / 48_000);
    if (!seconds) return null;

    // Bytes per sample for each page, then resampled to the waveform's width.
    const density = [];
    let previous = Math.max(0, pages[1].granule);
    for (const page of audio) {
        const span = page.granule - previous;
        previous = page.granule;
        if (span > 0) density.push(page.bodyLength / span);
    }
    if (!density.length) return null;
    const width = Math.min(MAX_WAVEFORM_SAMPLES, density.length);
    const samples = [];
    for (let i = 0; i < width; i++) {
        const from = Math.floor((i * density.length) / width);
        const to = Math.max(from + 1, Math.floor(((i + 1) * density.length) / width));
        const slice = density.slice(from, to);
        samples.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
    }
    const low = Math.min(...samples);
    const high = Math.max(...samples);
    const waveform = Buffer.from(samples.map(value => (high > low ? Math.round(((value - low) / (high - low)) * 255) : 128)));
    return { seconds, waveform: waveform.toString('base64') };
}

/** Raw 16-bit little-endian PCM, in a WAV container a Discord client can play. */
function pcmToWav(pcm, { sampleRate = 24_000, channels = 1 } = {}) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

// ── The services ─────────────────────────────────────────────────────────────
//
// Each `speak(text)` resolves `{ audio, format, seconds?, waveform?, ledger }`:
// `format` is 'ogg' (Opus, which Discord can show as a voice message) or 'wav'
// (a plain audio attachment), and `ledger` is what to record in the usage
// ledger for the call.

function openaiSpeaker(aiSettings, guildId) {
    const { apiKey } = resolveApiKey(aiSettings, { field: 'openaiKey', envKey: process.env.OPENAI_API_KEY, guildId });
    if (!apiKey) return null;
    return {
        name: 'OpenAI',
        async speak(text) {
            const { OpenAI } = require('openai');
            const client = new OpenAI({ apiKey, timeout: SPEAK_TIMEOUT_MS });
            const response = await client.audio.speech.create({
                model: OPENAI_TTS_MODEL,
                voice: OPENAI_TTS_VOICE,
                input: text,
                response_format: 'opus'
            });
            const audio = Buffer.from(await response.arrayBuffer());
            const described = describeOggOpus(audio);
            const seconds = described?.seconds ?? null;
            return {
                audio,
                format: 'ogg',
                seconds,
                waveform: described?.waveform ?? null,
                ledger: {
                    provider: 'openai',
                    model: OPENAI_TTS_MODEL,
                    usage: {
                        inputTokens: Math.ceil(text.length / CHARS_PER_TOKEN),
                        // No length to read means no estimate; the input is
                        // still recorded so the call shows up at all.
                        outputTokens: seconds ? Math.ceil(seconds * OPENAI_TTS_TOKENS_PER_SECOND) : 0
                    }
                }
            };
        }
    };
}

function geminiSpeaker(aiSettings, guildId) {
    const { apiKey } = resolveApiKey(aiSettings, { field: 'geminiKey', envKey: process.env.GEMINI_API_KEY, guildId });
    if (!apiKey) return null;
    return {
        name: 'Gemini',
        async speak(text) {
            const { GoogleGenAI } = require('@google/genai');
            const client = new GoogleGenAI({ apiKey });
            const response = await client.models.generateContent({
                model: GEMINI_TTS_MODEL,
                contents: [{ role: 'user', parts: [{ text }] }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
                    abortSignal: AbortSignal.timeout(SPEAK_TIMEOUT_MS)
                }
            });
            const inline = response?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data)?.inlineData;
            if (!inline) throw new Error('no audio in the response');
            // Signed 16-bit PCM, its rate in the MIME type: `audio/L16;codec=pcm;rate=24000`.
            const rate = Number(/rate=(\d+)/.exec(inline.mimeType || '')?.[1]) || 24_000;
            const pcm = Buffer.from(inline.data, 'base64');
            const meta = response.usageMetadata;
            return {
                audio: pcmToWav(pcm, { sampleRate: rate }),
                format: 'wav',
                seconds: pcm.length / (rate * 2),
                ledger: {
                    provider: 'gemini',
                    model: GEMINI_TTS_MODEL,
                    usage: meta ? { inputTokens: meta.promptTokenCount || 0, outputTokens: meta.candidatesTokenCount || 0 } : null
                }
            };
        }
    };
}

/** Every service this guild has a key for, in the order to try them. */
function speakersFor(aiSettings, guildId) {
    const order = aiSettings?.provider === 'gemini'
        ? [geminiSpeaker, openaiSpeaker]
        : [openaiSpeaker, geminiSpeaker];
    return order.map(make => make(aiSettings || {}, guildId)).filter(Boolean);
}

/**
 * The payloads to try posting, best first: a native voice message for Opus
 * (which Discord requires to carry nothing but the clip), then the same clip
 * as a plain attachment in case the voice-message form is refused.
 */
function audioPayloads(spoken) {
    if (spoken.format === 'ogg') {
        const plain = { files: [{ attachment: spoken.audio, name: 'reply.ogg' }] };
        if (!spoken.seconds || !spoken.waveform) return [plain];
        const voice = new AttachmentBuilder(spoken.audio, {
            name: 'voice-message.ogg',
            duration: spoken.seconds,
            waveform: spoken.waveform
        });
        return [{ files: [voice], flags: MessageFlags.IsVoiceMessage }, plain];
    }
    return [{ files: [{ attachment: spoken.audio, name: 'reply.wav' }] }];
}

/**
 * Read a finished reply aloud and post the audio.
 *
 * Never throws and never says anything when it fails: the text reply is
 * already posted and complete, and an error message about audio nobody asked
 * for out loud would be noise.
 *
 * @param {object} opts
 * @param {(payload: object) => Promise} opts.deliver posts one payload in the
 *   conversation the reply went to
 * @returns {Promise<boolean>} whether audio was posted
 */
async function sendSpokenReply(text, aiSettings, guildId, {
    deliver,
    rateLimit = null,
    speakers = speakersFor(aiSettings, guildId),
    record = recordUsage
} = {}) {
    try {
        if (!speakers.length) return false;
        const input = spokenText(text);
        if (!input) return false;
        // Out of budget means no audio either: the text has been answered
        // already, and this is the optional part.
        if (rateLimit) enforceMonthlyBudget(guildId, rateLimit);

        for (const speaker of speakers) {
            let spoken;
            try {
                spoken = await speaker.speak(input);
            } catch (err) {
                console.warn(`[AI:voice] ${speaker.name} speech failed: ${err.message}`);
                continue;
            }
            if (spoken?.ledger?.usage) {
                Promise.resolve()
                    .then(() => record(guildId, spoken.ledger.provider, spoken.ledger.model, spoken.ledger.usage))
                    .catch(err => console.warn(`[AI:voice] could not record speech usage: ${err.message}`));
            }
            if (!spoken?.audio?.length) continue;

            for (const payload of audioPayloads(spoken)) {
                try {
                    await deliver(payload);
                    return true;
                } catch (err) {
                    console.warn(`[AI:voice] could not post the spoken reply: ${err.message}`);
                }
            }
            // Made but not postable: a second service's audio would be refused
            // the same way, and paid for.
            return false;
        }
        return false;
    } catch (err) {
        console.warn(`[AI:voice] spoken reply skipped: ${err.message}`);
        return false;
    }
}

module.exports = {
    VOICE_REPLY_MODES,
    MAX_SPOKEN_CHARS,
    OPENAI_TTS_MODEL,
    GEMINI_TTS_MODEL,
    shouldSpeak,
    spokenText,
    describeOggOpus,
    pcmToWav,
    speakersFor,
    sendSpokenReply
};
