'use strict';

// Voice transcription in the usage ledger and the monthly budget (#1230): each
// clip is a paid call, so it is recorded under the provider and model that did
// the work, and a guild that is out of budget is refused before it pays for one.

const { Readable } = require('stream');

const mockTranscriptionCreate = jest.fn();
jest.mock('openai', () => ({
    OpenAI: jest.fn(() => ({ audio: { transcriptions: { create: mockTranscriptionCreate } } })),
    toFile: jest.fn(async (buffer, name) => ({ buffer, name })),
}));
const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn(() => ({ models: { generateContent: mockGenerateContent } })),
}));
jest.mock('../src/models/AIUsage', () => ({ find: jest.fn(() => ({ lean: async () => [] })), updateOne: jest.fn(async () => ({})) }));

const {
    transcribeClip,
    transcribersFor,
    openaiTranscriptionUsage,
    geminiUsage,
    OPENAI_TRANSCRIBE_MODEL,
    GEMINI_TRANSCRIBE_LEDGER_MODEL,
} = require('../src/services/ai/transcription');
const { estimateCost, bumpMonthlyUsage, resetMonthlyUsageCache, peekMonthlyUsage } = require('../src/services/ai/usage');

const CLIP = { url: 'https://cdn.discordapp.com/a/voice-message.ogg', name: 'voice-message.ogg', mimeType: 'audio/ogg' };
const download = () => jest.fn(async () => ({ ok: true, status: 200, body: Readable.toWeb(Readable.from([Buffer.from('OggS')])) }));
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
    jest.clearAllMocks();
    resetMonthlyUsageCache();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('reading each provider\'s usage', () => {
    test('OpenAI reports tokens for the gpt-4o transcribe models', () => {
        expect(openaiTranscriptionUsage({ text: 'hi', usage: { type: 'tokens', input_tokens: 120, output_tokens: 9, total_tokens: 129 } }))
            .toEqual({ inputTokens: 120, outputTokens: 9 });
        // whisper's per-second usage, or none at all, is nothing to record.
        expect(openaiTranscriptionUsage({ text: 'hi', usage: { type: 'duration', seconds: 4 } })).toBeNull();
        expect(openaiTranscriptionUsage('hi')).toBeNull();
    });

    test('Gemini reports usageMetadata', () => {
        expect(geminiUsage({ usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 15 } })).toEqual({ inputTokens: 200, outputTokens: 15 });
        expect(geminiUsage({ text: 'hi' })).toBeNull();
    });
});

describe('a transcribed clip goes in the ledger', () => {
    test('under OpenAI and its transcription model', async () => {
        mockTranscriptionCreate.mockResolvedValue({ text: 'call mum', usage: { type: 'tokens', input_tokens: 120, output_tokens: 9 } });
        const record = jest.fn(async () => {});
        const [openai] = transcribersFor({ openaiKey: 'sk-test' }, 'g1');

        const result = await transcribeClip(CLIP, {}, 'g1', { transcribers: [openai], requestImpl: download(), record });
        await flush();

        expect(result).toEqual({ text: 'call mum', service: 'OpenAI' });
        expect(record).toHaveBeenCalledWith('g1', 'openai', OPENAI_TRANSCRIBE_MODEL, { inputTokens: 120, outputTokens: 9 });
    });

    test('under Gemini, as audio', async () => {
        mockGenerateContent.mockResolvedValue({ text: 'call mum', usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 15 } });
        const record = jest.fn(async () => {});
        const [gemini] = transcribersFor({ provider: 'gemini', geminiKey: 'g-test' }, 'g1');

        await transcribeClip(CLIP, {}, 'g1', { transcribers: [gemini], requestImpl: download(), record });
        await flush();

        expect(record).toHaveBeenCalledWith('g1', 'gemini', GEMINI_TRANSCRIBE_LEDGER_MODEL, { inputTokens: 200, outputTokens: 15 });
    });

    test('a clip that heard nothing was still billed, and is still recorded', async () => {
        const record = jest.fn(async () => {});
        const transcriber = { name: 'OpenAI', transcribe: async () => ({ text: '', ledger: { provider: 'openai', model: 'm', usage: { inputTokens: 50, outputTokens: 0 } } }) };
        const result = await transcribeClip(CLIP, {}, 'g1', { transcribers: [transcriber], requestImpl: download(), record });
        await flush();
        expect(result.error).toMatch(/could not make out/);
        expect(record).toHaveBeenCalledTimes(1);
    });

    test('a ledger write that fails does not cost the transcript', async () => {
        const transcriber = { name: 'OpenAI', transcribe: async () => ({ text: 'hi', ledger: { provider: 'openai', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } } }) };
        const record = jest.fn(async () => { throw new Error('mongo down'); });
        await expect(transcribeClip(CLIP, {}, 'g1', { transcribers: [transcriber], requestImpl: download(), record }))
            .resolves.toEqual({ text: 'hi', service: 'OpenAI' });
    });
});

describe('the monthly budget', () => {
    test('refuses a clip once it is spent, before anything is downloaded', async () => {
        // Load the month's totals, then spend past the ceiling.
        peekMonthlyUsage('g1');
        await flush();
        bumpMonthlyUsage('g1', 5000, 1);

        const requestImpl = download();
        const transcriber = { name: 'OpenAI', transcribe: jest.fn(async () => 'hi') };
        const result = await transcribeClip(CLIP, {}, 'g1', {
            transcribers: [transcriber], requestImpl,
            rateLimit: { monthlyTokens: 1000, monthlyCost: 0 },
        });

        expect(result.error).toMatch(/monthly AI budget/);
        expect(requestImpl).not.toHaveBeenCalled();
        expect(transcriber.transcribe).not.toHaveBeenCalled();
    });

    test('lets a clip through while there is budget left', async () => {
        peekMonthlyUsage('g1');
        await flush();
        const transcriber = { name: 'OpenAI', transcribe: async () => 'hi' };
        await expect(transcribeClip(CLIP, {}, 'g1', { transcribers: [transcriber], requestImpl: download(), rateLimit: { monthlyTokens: 1000 } }))
            .resolves.toEqual({ text: 'hi', service: 'OpenAI' });
    });
});

test('the speech models are priced as audio, not as the text model they are named after', () => {
    // gpt-4o-mini-transcribe would otherwise match the gpt-4o-mini text row.
    expect(estimateCost('openai', 'gpt-4o-mini-transcribe', 1_000_000, 0)).toBeCloseTo(3.00);
    expect(estimateCost('openai', 'gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15);
    expect(estimateCost('openai', 'gpt-4o-mini-tts', 0, 1_000_000)).toBeCloseTo(12.00);
    expect(estimateCost('gemini', GEMINI_TRANSCRIBE_LEDGER_MODEL, 1_000_000, 0)).toBeCloseTo(1.00);
    expect(estimateCost('gemini', 'gemini-2.5-flash-preview-tts', 0, 1_000_000)).toBeCloseTo(10.00);
    expect(estimateCost('gemini', 'gemini-3.8-flash', 1_000_000, 0)).toBeCloseTo(0.10);
});
