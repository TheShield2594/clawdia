'use strict';

// The operator's ceilings on environment-key spend (#1147) were applied only
// when the *chat* provider's key was the operator's. Images, transcription,
// speech and embeddings each resolve a key of their own, so a guild chatting on
// its own Anthropic key with its limits at 0 spent the operator's OpenAI or
// Gemini key on all of them with no ceiling. Each is now held to the operator's
// ceilings whenever its own key is the environment's.

const mockTotals = new Map();
jest.mock('../src/services/ai/usage', () => {
    const actual = jest.requireActual('../src/services/ai/usage');
    return {
        ...actual,
        peekMonthlyUsage: guildId => mockTotals.get(guildId) || null,
        recordUsage: jest.fn(async () => {})
    };
});

const { recordUsage } = require('../src/services/ai/usage');
const { budgetRefusal, guildLimitsOf } = require('../src/services/ai/rateLimit');
const { generateImage } = require('../src/services/ai/images');
const { transcribeClip } = require('../src/services/ai/transcription');
const { sendSpokenReply } = require('../src/services/ai/speech');
const { ENV_KEY_DEFAULTS } = require('../src/services/ai/apiKeys');

// A guild on its own chat key, with no limits of its own.
const OWN_KEY_LIMITS = guildLimitsOf({});
// Past the operator's default token ceiling, and nowhere near any guild limit.
const spentPastCeiling = guildId => mockTotals.set(guildId, { tokens: ENV_KEY_DEFAULTS.monthlyTokens + 1, cost: 0, costKnown: true });

beforeEach(() => {
    mockTotals.clear();
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('budgetRefusal', () => {
    test('a call on the operator\'s key is held to the operator\'s ceiling, whatever the guild set', () => {
        spentPastCeiling('g1');
        expect(budgetRefusal('g1', OWN_KEY_LIMITS, 'env')).toMatch(/monthly AI budget/);
    });

    test('a call on the guild\'s own key is held to the guild\'s limits only', () => {
        spentPastCeiling('g1');
        expect(budgetRefusal('g1', OWN_KEY_LIMITS, 'guild')).toBeNull();
    });

    test('with no limits passed at all, the operator\'s key still has its ceiling', () => {
        spentPastCeiling('g1');
        expect(budgetRefusal('g1', null, 'env')).toMatch(/monthly AI budget/);
        expect(budgetRefusal('g1', null, 'guild')).toBeNull();
    });
});

describe('each media call', () => {
    const generator = keySource => ({
        name: keySource,
        keySource,
        generate: jest.fn(async () => ({ image: Buffer.from('png'), mimeType: 'image/png', ledger: null }))
    });

    test('an image skips a service on the operator\'s key past its ceiling, and uses one on the guild\'s', async () => {
        spentPastCeiling('g-img');
        const env = generator('env');
        const own = generator('guild');
        const result = await generateImage(
            { prompt: 'a cat' },
            { guildId: 'g-img', userId: 'u1', rateLimit: OWN_KEY_LIMITS, generators: [env, own], turn: { count: 0, pending: 0 } },
            { attach: () => true }
        );
        expect(env.generate).not.toHaveBeenCalled();
        expect(own.generate).toHaveBeenCalled();
        expect(result).toMatch(/will be posted/);
    });

    test('an image with only the operator\'s key past its ceiling says why', async () => {
        spentPastCeiling('g-img2');
        const env = generator('env');
        const result = await generateImage(
            { prompt: 'a cat' },
            { guildId: 'g-img2', userId: 'u2', rateLimit: OWN_KEY_LIMITS, generators: [env], turn: { count: 0, pending: 0 } },
            { attach: () => true }
        );
        expect(env.generate).not.toHaveBeenCalled();
        expect(result).toMatch(/No image was made: .*monthly AI budget/);
    });

    test('a voice message is not transcribed on the operator\'s key past its ceiling', async () => {
        spentPastCeiling('g-voice');
        const transcriber = { name: 'env', keySource: 'env', transcribe: jest.fn() };
        const download = jest.fn();
        const heard = await transcribeClip(
            { url: 'https://cdn.discordapp.com/a.ogg', name: 'a.ogg', mimeType: 'audio/ogg' },
            {}, 'g-voice',
            { transcribers: [transcriber], rateLimit: OWN_KEY_LIMITS, requestImpl: download }
        );
        expect(heard.error).toMatch(/monthly AI budget/);
        // Refused before anything was downloaded, let alone sent.
        expect(download).not.toHaveBeenCalled();
        expect(transcriber.transcribe).not.toHaveBeenCalled();
    });

    test('a spoken reply is not voiced on the operator\'s key past its ceiling', async () => {
        spentPastCeiling('g-speech');
        const speaker = { name: 'env', keySource: 'env', speak: jest.fn() };
        const posted = await sendSpokenReply('hello there', {}, 'g-speech', { deliver: jest.fn(), rateLimit: OWN_KEY_LIMITS, speakers: [speaker] });
        expect(posted).toBe(false);
        expect(speaker.speak).not.toHaveBeenCalled();
    });
});

describe('embeddings', () => {
    const create = jest.fn(async ({ input }) => ({
        data: input.map(() => ({ embedding: [0.1, 0.2] })),
        usage: { prompt_tokens: 7 }
    }));

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('openai', () => jest.fn().mockImplementation(() => ({ embeddings: { create } })));
        process.env.OPENAI_API_KEY = 'sk-env';
        process.env.AI_ENV_KEY_GUILDS = '*';
    });
    afterEach(() => {
        delete process.env.OPENAI_API_KEY;
        delete process.env.AI_ENV_KEY_GUILDS;
    });

    const settings = { semanticRetrieval: { enabled: true, provider: 'openai' } };

    test('are recorded in the ledger the ceiling reads', async () => {
        const { getEmbedder } = require('../src/services/ai/embeddings');
        const { recordUsage: record } = require('../src/services/ai/usage');
        const embedder = await getEmbedder(settings, 'g-emb');
        expect(embedder).not.toBeNull();

        await embedder.embed(['hello']);
        await new Promise(resolve => setImmediate(resolve));

        expect(record).toHaveBeenCalledWith('g-emb', 'openai', expect.any(String), { inputTokens: 7, outputTokens: 0 });
    });

    test('are refused past the operator\'s ceiling, which the caller reads as no vector', async () => {
        const { getEmbedder } = require('../src/services/ai/embeddings');
        spentPastCeiling('g-emb2');
        const embedder = await getEmbedder(settings, 'g-emb2');

        await expect(embedder.embed(['hello'])).rejects.toThrow(/monthly AI budget/);
        expect(create).not.toHaveBeenCalled();
    });
});

test('recordUsage is the mocked one', () => {
    // Guards the suite: nothing above may write to a real ledger.
    expect(jest.isMockFunction(recordUsage)).toBe(true);
});
