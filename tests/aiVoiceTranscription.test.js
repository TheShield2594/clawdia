'use strict';

// Voice messages, transcribed so the model can answer them.

const { Readable } = require('stream');
const {
    collectVoice,
    transcribeClip,
    transcriberFor,
    voiceTurn,
    audioMimeType,
    MAX_AUDIO_BYTES,
    MAX_AUDIO_SECONDS
} = require('../src/services/ai/transcription');

const KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_ENV_KEY_GUILDS'];
const saved = {};
beforeEach(() => {
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    jest.restoreAllMocks();
});

const voiceMessage = (attachments) => ({ attachments: new Map(attachments.map((a, i) => [String(i), a])) });
const VOICE = { url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg', name: 'voice-message.ogg', contentType: 'audio/ogg', size: 40_000, duration: 6.2 };

describe('collectVoice', () => {
    test('finds a voice message', () => {
        const { clip } = collectVoice(voiceMessage([VOICE]));
        expect(clip).toMatchObject({ url: VOICE.url, mimeType: 'audio/ogg', seconds: 6.2 });
    });

    test('ignores everything that is not audio', () => {
        expect(collectVoice(voiceMessage([{ url: 'https://x/a.png', contentType: 'image/png' }])).clip).toBeNull();
        expect(collectVoice({}).clip).toBeNull();
    });

    test('takes the extension when the type is missing', () => {
        expect(audioMimeType({ name: 'memo.m4a' })).toBe('audio/mp4');
        expect(audioMimeType({ name: 'memo.exe', contentType: 'application/x-msdownload' })).toBeNull();
    });

    test('refuses a clip too long or too large, and says why', () => {
        expect(collectVoice(voiceMessage([{ ...VOICE, duration: MAX_AUDIO_SECONDS + 1 }]))).toEqual({ clip: null, refused: expect.stringMatching(/longer than 10 minutes/) });
        expect(collectVoice(voiceMessage([{ ...VOICE, size: MAX_AUDIO_BYTES + 1 }]))).toEqual({ clip: null, refused: expect.stringMatching(/too large/) });
    });
});

describe('which service listens', () => {
    test('Gemini first for a guild on Gemini, OpenAI first otherwise', () => {
        const both = { openaiKey: 'sk-test', geminiKey: 'g-test' };
        expect(transcriberFor({ ...both, provider: 'gemini' }, null).name).toBe('Gemini');
        expect(transcriberFor({ ...both, provider: 'anthropic' }, null).name).toBe('OpenAI');
    });

    test('a guild on a provider that takes no audio uses whichever key it has', () => {
        expect(transcriberFor({ provider: 'anthropic', geminiKey: 'g-test' }, null).name).toBe('Gemini');
        expect(transcriberFor({ provider: 'ollama' }, null)).toBeNull();
    });
});

describe('transcribeClip', () => {
    const clip = { url: VOICE.url, name: VOICE.name, mimeType: 'audio/ogg' };
    const download = (bytes = Buffer.from('OggS...'), status = 200) => jest.fn(async () => ({
        ok: status === 200,
        status,
        body: Readable.toWeb(Readable.from([bytes]))
    }));

    test('downloads through the SSRF guard and returns the transcript', async () => {
        const { guardedDispatcher } = require('../src/utils/outboundGuard');
        const requestImpl = download();
        const transcriber = { name: 'OpenAI', transcribe: jest.fn(async () => '  remind me to call mum at six  ') };

        const result = await transcribeClip(clip, {}, 'g1', { transcribers: [transcriber], requestImpl });

        expect(requestImpl.mock.calls[0][1].dispatcher).toBe(guardedDispatcher());
        expect(transcriber.transcribe).toHaveBeenCalledWith(Buffer.from('OggS...'), clip);
        expect(result).toEqual({ text: 'remind me to call mum at six', service: 'OpenAI' });
    });

    test('every failure is a sentence for the user, never a throw', async () => {
        const ok = { name: 'OpenAI', transcribe: async () => 'hi' };
        await expect(transcribeClip(clip, {}, 'g1', { transcribers: [] })).resolves.toEqual({ error: expect.stringMatching(/no OpenAI or Gemini key/) });
        await expect(transcribeClip(clip, {}, 'g1', { transcribers: [ok], requestImpl: download(Buffer.from('x'), 404) })).resolves.toEqual({ error: expect.stringMatching(/could not download/) });
        await expect(transcribeClip({ ...clip, url: 'http://127.0.0.1/a.ogg' }, {}, 'g1', { transcribers: [ok], requestImpl: download() })).resolves.toEqual({ error: expect.stringMatching(/could not download/) });
        const broken = { name: 'OpenAI', transcribe: async () => { throw new Error('429'); } };
        await expect(transcribeClip(clip, {}, 'g1', { transcribers: [broken], requestImpl: download() })).resolves.toEqual({ error: expect.stringMatching(/could not transcribe/) });
        const silent = { name: 'OpenAI', transcribe: async () => '   ' };
        await expect(transcribeClip(clip, {}, 'g1', { transcribers: [silent], requestImpl: download() })).resolves.toEqual({ error: expect.stringMatching(/could not make out/) });
    });
});

describe('choosing a service by format, and falling through', () => {
    const download = () => jest.fn(async () => ({ ok: true, status: 200, body: Readable.toWeb(Readable.from([Buffer.from('audio')])) }));
    const aac = { url: VOICE.url, name: 'memo.aac', mimeType: 'audio/aac' };
    const service = (name, formats, transcribe = async () => `${name} heard it`) =>
        ({ name, accepts: clip => formats.includes(clip.mimeType), transcribe: jest.fn(transcribe) });

    test('a format only Gemini reads goes to Gemini even when OpenAI is first', async () => {
        const openai = service('OpenAI', ['audio/ogg']);
        const gemini = service('Gemini', ['audio/ogg', 'audio/aac']);
        const result = await transcribeClip(aac, {}, 'g1', { transcribers: [openai, gemini], requestImpl: download() });
        expect(openai.transcribe).not.toHaveBeenCalled();
        expect(result).toEqual({ text: 'Gemini heard it', service: 'Gemini' });
    });

    test('a format no available service reads is refused before anything is downloaded', async () => {
        const requestImpl = download();
        const result = await transcribeClip(aac, {}, 'g1', { transcribers: [service('OpenAI', ['audio/ogg'])], requestImpl });
        expect(result.error).toMatch(/audio\/aac is not a format/);
        expect(requestImpl).not.toHaveBeenCalled();
    });

    test('a failure on the first service is tried once more on the next', async () => {
        const openai = service('OpenAI', ['audio/ogg'], async () => { throw new Error('503'); });
        const gemini = service('Gemini', ['audio/ogg']);
        const clip = { url: VOICE.url, name: VOICE.name, mimeType: 'audio/ogg' };
        await expect(transcribeClip(clip, {}, 'g1', { transcribers: [openai, gemini], requestImpl: download() }))
            .resolves.toEqual({ text: 'Gemini heard it', service: 'Gemini' });
    });

    test('silence is an answer, not a failure to retry', async () => {
        const openai = service('OpenAI', ['audio/ogg'], async () => '');
        const gemini = service('Gemini', ['audio/ogg']);
        const clip = { url: VOICE.url, name: VOICE.name, mimeType: 'audio/ogg' };
        const result = await transcribeClip(clip, {}, 'g1', { transcribers: [openai, gemini], requestImpl: download() });
        expect(result.error).toMatch(/could not make out/);
        expect(gemini.transcribe).not.toHaveBeenCalled();
    });

    test('the real services declare what they read: OpenAI not raw AAC, Gemini yes', () => {
        const { transcribersFor } = require('../src/services/ai/transcription');
        const [openai, gemini] = transcribersFor({ openaiKey: 'sk-test', geminiKey: 'g-test' }, null);
        expect(openai.accepts({ mimeType: 'audio/aac' })).toBe(false);
        expect(openai.accepts({ mimeType: 'audio/ogg' })).toBe(true);
        expect(gemini.accepts({ mimeType: 'audio/aac' })).toBe(true);
        expect(gemini.accepts({ mimeType: 'audio/x-m4a' })).toBe(true);
    });
});

test('the turn says it was spoken, and keeps any typed text first', () => {
    expect(voiceTurn('book a table')).toBe('[Voice message, transcribed]\nbook a table');
    expect(voiceTurn('book a table', 'for Friday')).toBe('for Friday\n\n[Voice message, transcribed]\nbook a table');
});
