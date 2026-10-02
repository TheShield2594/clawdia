'use strict';

// Spoken replies (#1231): the reply read aloud and posted after the text,
// recorded in the ledger, and silent whenever any of it fails.

const mockSpeechCreate = jest.fn();
jest.mock('openai', () => ({
    OpenAI: jest.fn(() => ({ audio: { speech: { create: mockSpeechCreate } } })),
}));
const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn(() => ({ models: { generateContent: mockGenerateContent } })),
}));
jest.mock('../src/models/AIUsage', () => ({ find: jest.fn(() => ({ lean: async () => [] })), updateOne: jest.fn(async () => ({})) }));

const { MessageFlags } = require('discord.js');
const {
    shouldSpeak,
    spokenText,
    describeOggOpus,
    pcmToWav,
    speakersFor,
    sendSpokenReply,
    MAX_SPOKEN_CHARS,
    OPENAI_TTS_MODEL,
    GEMINI_TTS_MODEL,
} = require('../src/services/ai/speech');
const { bumpMonthlyUsage, resetMonthlyUsageCache, peekMonthlyUsage } = require('../src/services/ai/usage');

const KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_ENV_KEY_GUILDS'];
const saved = {};
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
    jest.clearAllMocks();
    resetMonthlyUsageCache();
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    jest.restoreAllMocks();
});

// ── A small Ogg Opus file, built by hand ─────────────────────────────────────

function oggPage(granule, body) {
    const header = Buffer.alloc(27);
    header.write('OggS', 0, 'latin1');
    header.writeBigInt64LE(BigInt(granule), 6);
    header[26] = 1;
    return Buffer.concat([header, Buffer.from([body.length]), body]);
}

function oggOpus({ preSkip = 312, pages = [100, 20, 200] } = {}) {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = 1;
    head.writeUInt16LE(preSkip, 10);
    const parts = [oggPage(0, head), oggPage(0, Buffer.from('OpusTags'))];
    // One second of audio a page, each spending a different number of bytes.
    pages.forEach((size, i) => parts.push(oggPage(preSkip + 48_000 * (i + 1), Buffer.alloc(size, 1))));
    return Buffer.concat(parts);
}

describe('when to speak', () => {
    test('follows the mode', () => {
        expect(shouldSpeak('off', { spokenTo: true, inDm: true })).toBe(false);
        expect(shouldSpeak(undefined, { spokenTo: true })).toBe(false);
        expect(shouldSpeak('when-spoken-to', { spokenTo: true })).toBe(true);
        expect(shouldSpeak('when-spoken-to', { inDm: true })).toBe(false);
        expect(shouldSpeak('always-in-dms', { inDm: true })).toBe(true);
        expect(shouldSpeak('always-in-dms', { spokenTo: true })).toBe(true);
        expect(shouldSpeak('always-in-dms', {})).toBe(false);
    });
});

describe('what is read out', () => {
    test('drops markdown, links, mentions and code', () => {
        const text = '## Plan\n**Call** <@123> at _six_. See [the docs](https://x.y/z) or https://a.b/c\n```js\nlet x;\n```\n- done <:cat:42>';
        expect(spokenText(text)).toBe('Plan Call at six. See the docs or a link (code is in the text) done');
    });

    test('is capped, at a sentence where it can be, and says the rest is in the text', () => {
        const sentence = 'This is one sentence of a long answer. ';
        const spoken = spokenText(sentence.repeat(100));
        expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 40);
        expect(spoken).toMatch(/answer\. … The rest is in the text\.$/);
        expect(spokenText('short')).toBe('short');
    });
});

describe('reading an Ogg Opus clip', () => {
    test('its length comes from the last granule, less the pre-skip', () => {
        const described = describeOggOpus(oggOpus());
        expect(described.seconds).toBeCloseTo(3);
    });

    test('its waveform follows how many bytes each stretch spends', () => {
        const waveform = Buffer.from(describeOggOpus(oggOpus()).waveform, 'base64');
        // The quietest page is 0, the busiest 255; the first sits between them
        // (a little below 80/180 of the way, as its span includes the pre-skip).
        expect([...waveform].slice(1)).toEqual([0, 255]);
        expect(waveform[0]).toBeGreaterThan(105);
        expect(waveform[0]).toBeLessThan(115);
    });

    test('anything else is not described', () => {
        expect(describeOggOpus(Buffer.from('not ogg at all, not even close'))).toBeNull();
        expect(describeOggOpus(null)).toBeNull();
    });
});

test('PCM is wrapped in a WAV header', () => {
    const wav = pcmToWav(Buffer.alloc(48_000), { sampleRate: 24_000 });
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(48_000);
    expect(wav.length).toBe(44 + 48_000);
});

describe('sending a spoken reply', () => {
    const ogg = () => ({ name: 'OpenAI', speak: jest.fn(async () => ({
        audio: oggOpus(), format: 'ogg', seconds: 3, waveform: 'AAEC',
        ledger: { provider: 'openai', model: OPENAI_TTS_MODEL, usage: { inputTokens: 5, outputTokens: 63 } },
    })) });

    test('posts a voice message and records the cost', async () => {
        const deliver = jest.fn(async () => ({}));
        const record = jest.fn(async () => {});
        const speaker = ogg();

        await expect(sendSpokenReply('**Hello** there', {}, 'g1', { speakers: [speaker], deliver, record })).resolves.toBe(true);
        await flush();

        expect(speaker.speak).toHaveBeenCalledWith('Hello there');
        const payload = deliver.mock.calls[0][0];
        expect(payload.flags).toBe(MessageFlags.IsVoiceMessage);
        expect(payload.content).toBeUndefined();
        expect(payload.files[0]).toMatchObject({ name: 'voice-message.ogg', duration: 3, waveform: 'AAEC' });
        expect(record).toHaveBeenCalledWith('g1', 'openai', OPENAI_TTS_MODEL, { inputTokens: 5, outputTokens: 63 });
    });

    test('falls back to a plain attachment when the voice-message form is refused', async () => {
        const deliver = jest.fn()
            .mockRejectedValueOnce(new Error('Cannot send voice messages'))
            .mockResolvedValueOnce({});
        await expect(sendSpokenReply('hi', {}, 'g1', { speakers: [ogg()], deliver, record: async () => {} })).resolves.toBe(true);
        expect(deliver.mock.calls[1][0]).toEqual({ files: [{ attachment: expect.any(Buffer), name: 'reply.ogg' }] });
    });

    test('tries the next service when one fails', async () => {
        const broken = { name: 'OpenAI', speak: async () => { throw new Error('503'); } };
        const wav = { name: 'Gemini', speak: async () => ({ audio: Buffer.from('RIFF'), format: 'wav', ledger: null }) };
        const deliver = jest.fn(async () => ({}));
        await expect(sendSpokenReply('hi', {}, 'g1', { speakers: [broken, wav], deliver })).resolves.toBe(true);
        expect(deliver).toHaveBeenCalledWith({ files: [{ attachment: Buffer.from('RIFF'), name: 'reply.wav' }] });
    });

    test('every failure is silent: no throw, and nothing posted', async () => {
        const deliver = jest.fn(async () => { throw new Error('Missing Permissions'); });
        await expect(sendSpokenReply('hi', {}, 'g1', { speakers: [ogg()], deliver, record: async () => {} })).resolves.toBe(false);

        const broken = { name: 'OpenAI', speak: async () => { throw new Error('401'); } };
        const quiet = jest.fn();
        await expect(sendSpokenReply('hi', {}, 'g1', { speakers: [broken], deliver: quiet })).resolves.toBe(false);
        await expect(sendSpokenReply('hi', {}, 'g1', { speakers: [], deliver: quiet })).resolves.toBe(false);
        await expect(sendSpokenReply('```only code```', {}, 'g1', { speakers: [ogg()], deliver: quiet })).resolves.toBe(true);
        expect(quiet).toHaveBeenCalledTimes(1);
    });

    test('nothing is spoken for a guild that is out of budget', async () => {
        peekMonthlyUsage('g1');
        await flush();
        bumpMonthlyUsage('g1', 5000, 1);
        const speaker = ogg();
        const deliver = jest.fn();

        await expect(sendSpokenReply('hi', {}, 'g1', { speakers: [speaker], deliver, rateLimit: { monthlyTokens: 1000 } })).resolves.toBe(false);
        expect(speaker.speak).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
    });
});

describe('the real services', () => {
    test('chosen the same way transcription is', () => {
        const both = { openaiKey: 'sk-test', geminiKey: 'g-test' };
        expect(speakersFor({ ...both, provider: 'gemini' }, null).map(s => s.name)).toEqual(['Gemini', 'OpenAI']);
        expect(speakersFor({ ...both, provider: 'anthropic' }, null).map(s => s.name)).toEqual(['OpenAI', 'Gemini']);
        expect(speakersFor({ provider: 'ollama' }, null)).toEqual([]);
    });

    test('OpenAI returns Opus, described and estimated for the ledger', async () => {
        const clip = oggOpus();
        mockSpeechCreate.mockResolvedValue({ arrayBuffer: async () => clip.buffer.slice(clip.byteOffset, clip.byteOffset + clip.length) });
        const [openai] = speakersFor({ openaiKey: 'sk-test' }, null);

        const spoken = await openai.speak('Hello there, this is forty characters...');

        expect(mockSpeechCreate).toHaveBeenCalledWith(expect.objectContaining({ model: OPENAI_TTS_MODEL, response_format: 'opus' }));
        expect(spoken).toMatchObject({ format: 'ogg', seconds: 3, ledger: { provider: 'openai', model: OPENAI_TTS_MODEL } });
        expect(spoken.ledger.usage).toEqual({ inputTokens: 10, outputTokens: 63 });
    });

    test('Gemini returns PCM, wrapped as WAV, with its usageMetadata', async () => {
        mockGenerateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(96_000).toString('base64') } }] } }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 50 },
        });
        const [gemini] = speakersFor({ provider: 'gemini', geminiKey: 'g-test' }, null);

        const spoken = await gemini.speak('Hello');

        expect(mockGenerateContent.mock.calls[0][0]).toMatchObject({ model: GEMINI_TTS_MODEL, config: { responseModalities: ['AUDIO'] } });
        expect(spoken.format).toBe('wav');
        expect(spoken.seconds).toBeCloseTo(2);
        expect(spoken.audio.toString('latin1', 0, 4)).toBe('RIFF');
        expect(spoken.ledger).toEqual({ provider: 'gemini', model: GEMINI_TTS_MODEL, usage: { inputTokens: 12, outputTokens: 50 } });
    });
});
