'use strict';

// Generated images (#1229): a generate_image tool offered only with the switch
// on and a usable key, the picture posted the way a tool's images are, every
// call in the usage ledger and under the monthly ceiling, and a refusal or a
// failure answered in words rather than thrown.

const mockImagesGenerate = jest.fn();
jest.mock('openai', () => ({
    OpenAI: jest.fn(() => ({ images: { generate: mockImagesGenerate } })),
}));
const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn(() => ({ models: { generateContent: mockGenerateContent } })),
}));
jest.mock('../src/models/AIUsage', () => ({ find: jest.fn(() => ({ lean: async () => [] })), updateOne: jest.fn(async () => ({})) }));
jest.mock('../src/models/KnowledgeBase', () => ({}));
jest.mock('../src/models/ConversationLog', () => ({}));

const AIUsage = require('../src/models/AIUsage');
const {
    generateImageTool,
    generateImage,
    imageGeneratorsFor,
    isOpenaiRefusal,
    MAX_IMAGES_PER_TURN,
    OPENAI_IMAGE_MODEL,
    GEMINI_IMAGE_MODEL
} = require('../src/services/ai/images');
const { buildAgentTools, buildAgentToolsAddendum } = require('../src/services/ai/agentTools');
const { prepareMcpToolkit } = require('../src/services/ai/mcp/toolkit');
const { createToolActivity } = require('../src/services/ai/mcp/activity');
const { bumpMonthlyUsage, resetMonthlyUsageCache, peekMonthlyUsage, estimateCost } = require('../src/services/ai/usage');
const { IMAGES_PER_WINDOW } = require('../src/services/ai/rateLimit');

const KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'AI_ENV_KEY_GUILDS'];
const saved = {};
const flush = () => new Promise(resolve => setImmediate(resolve));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let seq = 0;
const freshUser = () => `u-img-${++seq}`;

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

const ledger = { provider: 'openai', model: 'gpt-image-1', usage: { inputTokens: 20, outputTokens: 1056 } };
const drawing = (overrides = {}) => ({
    name: 'OpenAI',
    generate: jest.fn(async () => ({ image: PNG, mimeType: 'image/png', ledger, ...overrides }))
});
const context = (overrides = {}) => ({
    guildId: 'g1', userId: freshUser(), generators: [drawing()], turn: { count: 0 }, record: jest.fn(async () => {}), ...overrides
});
const runContext = (overrides = {}) => ({ attach: jest.fn(() => true), deadline: Date.now() + 60_000, ...overrides });

describe('when the tool is offered', () => {
    test('only with the switch on', () => {
        expect(buildAgentTools({ openaiKey: 'sk-test' }, { guildId: 'g1' })).toEqual([]);
        expect(buildAgentTools({ imageGeneration: true, openaiKey: 'sk-test' }, { guildId: 'g1' }).map(t => t.name))
            .toEqual(['generate_image']);
    });

    test('only with a key it can use', () => {
        expect(buildAgentTools({ imageGeneration: true, provider: 'anthropic' }, { guildId: 'g1' })).toEqual([]);
        expect(buildAgentTools({ imageGeneration: true }, { guildId: 'g1', imageGenerators: [drawing()] }).map(t => t.name))
            .toEqual(['generate_image']);
    });

    test('to scheduled runs too, needing no approval', () => {
        const [tool] = buildAgentTools({ imageGeneration: true, openaiKey: 'sk-test' }, { guildId: 'g1', unattended: true });
        expect(tool.name).toBe('generate_image');
        expect(tool.confirm).toBe(false);
    });

    test('with a rule telling the model what it costs and how it is posted', () => {
        const tools = buildAgentTools({ imageGeneration: true, openaiKey: 'sk-test' }, { guildId: 'g1' });
        expect(buildAgentToolsAddendum(tools)).toMatch(/generate_image[\s\S]*posted after your reply/);
    });

    test('chooses the services the way voice does', () => {
        const both = { openaiKey: 'sk-test', geminiKey: 'g-test' };
        expect(imageGeneratorsFor({ ...both, provider: 'gemini' }, null).map(g => g.name)).toEqual(['Gemini', 'OpenAI']);
        expect(imageGeneratorsFor({ ...both, provider: 'anthropic' }, null).map(g => g.name)).toEqual(['OpenAI', 'Gemini']);
        expect(imageGeneratorsFor({ provider: 'ollama' }, null)).toEqual([]);
    });
});

describe('posting', () => {
    test('offers the picture to the conversation with its prompt as alt text', async () => {
        const run = runContext();
        const ctx = context();
        const text = await generateImage({ prompt: 'a guild logo, a fox', size: 'landscape' }, ctx, run);

        expect(ctx.generators[0].generate).toHaveBeenCalledWith('a guild logo, a fox', 'landscape', expect.objectContaining({ signal: expect.anything() }));
        expect(run.attach).toHaveBeenCalledWith(expect.objectContaining({
            buffer: PNG, name: 'generated-image-1.png', description: 'Generated image: a guild logo, a fox'
        }));
        expect(text).toMatch(/will be posted in the conversation/);
    });

    test('says so when the reply cannot carry the file', async () => {
        const text = await generateImage({ prompt: 'x' }, context(), runContext({ attach: () => false }));
        expect(text).toMatch(/cannot carry any more files/);
    });

    test('reaches the channel through the toolkit and the turn\'s activity', async () => {
        const activity = createToolActivity();
        const tool = generateImageTool({ guildId: 'g1', userId: freshUser(), generators: [drawing()], record: jest.fn(async () => {}) });
        const toolkit = await prepareMcpToolkit([], { botTools: [tool], botToolsOnly: true, onToolEvent: activity.onEvent });

        const text = await toolkit.call('generate_image', { prompt: 'a banner for Friday' });

        expect(text).toMatch(/will be posted/);
        expect(activity.attachments).toEqual([
            { attachment: PNG, name: 'generated-image-1.png', description: 'Generated image: a banner for Friday' }
        ]);
    });

    test('never claims a post with nowhere to post it', async () => {
        const tool = generateImageTool({ guildId: 'g1', userId: freshUser(), generators: [drawing()], record: jest.fn(async () => {}) });
        const toolkit = await prepareMcpToolkit([], { botTools: [tool], botToolsOnly: true });
        expect(await toolkit.call('generate_image', { prompt: 'x' })).toMatch(/cannot carry any more files/);
    });

    test('at most a couple of images in one turn', async () => {
        const ctx = context();
        for (let n = 0; n < MAX_IMAGES_PER_TURN; n++) await generateImage({ prompt: `p${n}` }, ctx, runContext());
        expect(await generateImage({ prompt: 'one more' }, ctx, runContext())).toMatch(/at most 2/);
        expect(ctx.generators[0].generate).toHaveBeenCalledTimes(MAX_IMAGES_PER_TURN);
    });

    test('does not start one the turn cannot wait for', async () => {
        const ctx = context();
        expect(await generateImage({ prompt: 'x' }, ctx, runContext({ deadline: Date.now() + 5000 }))).toMatch(/not have enough time/);
        expect(ctx.generators[0].generate).not.toHaveBeenCalled();
    });
});

describe('refusals and failures', () => {
    test('a refusal is a sentence to relay, and is not shopped to the other service', async () => {
        const refusing = drawing({ refused: true, image: undefined });
        const other = drawing();
        const ctx = context({ generators: [refusing, other] });
        const run = runContext();

        const text = await generateImage({ prompt: 'something unsafe' }, ctx, run);

        expect(text).toMatch(/refused that prompt/);
        expect(other.generate).not.toHaveBeenCalled();
        expect(run.attach).not.toHaveBeenCalled();
        // A refusal can still be billed.
        expect(ctx.record).toHaveBeenCalledWith('g1', 'openai', 'gpt-image-1', ledger.usage);
    });

    test('a service that fails is tried once on the other, then answered in words', async () => {
        const broken = { name: 'OpenAI', generate: jest.fn(async () => { throw new Error('500'); }) };
        const ctx = context({ generators: [broken, drawing()] });
        expect(await generateImage({ prompt: 'x' }, ctx, runContext())).toMatch(/will be posted/);

        const allBroken = context({ generators: [broken, broken] });
        expect(await generateImage({ prompt: 'x' }, allBroken, runContext())).toMatch(/could not be made/);
    });

    test('an empty prompt draws nothing', async () => {
        const ctx = context();
        expect(await generateImage({ prompt: '  ' }, ctx, runContext())).toMatch(/prompt was empty/);
        expect(ctx.generators[0].generate).not.toHaveBeenCalled();
    });

    test('recognises OpenAI\'s moderation refusal', () => {
        expect(isOpenaiRefusal({ status: 400, code: 'moderation_blocked' })).toBe(true);
        expect(isOpenaiRefusal({ status: 400, message: 'Your request was rejected by the safety system.' })).toBe(true);
        expect(isOpenaiRefusal({ status: 500, message: 'oops' })).toBe(false);
    });
});

describe('cost', () => {
    test('every image is recorded in the usage ledger', async () => {
        const ctx = context();
        await generateImage({ prompt: 'x' }, ctx, runContext());
        await flush();
        expect(ctx.record).toHaveBeenCalledWith('g1', 'openai', 'gpt-image-1', { inputTokens: 20, outputTokens: 1056 });
    });

    test('and priced, so the monthly cost ceiling counts it', () => {
        // About four cents for a medium square image, not the price of text.
        expect(estimateCost('openai', 'gpt-image-1', 20, 1056)).toBeCloseTo(0.0423, 3);
        expect(estimateCost('gemini', 'gemini-2.5-flash-image', 10, 1290)).toBeCloseTo(0.0387, 3);
    });

    test('a guild out of budget gets no image and no charge', async () => {
        peekMonthlyUsage('g1');
        await flush();
        bumpMonthlyUsage('g1', 5000, 1);
        const ctx = context({ rateLimit: { monthlyTokens: 1000 } });

        expect(await generateImage({ prompt: 'x' }, ctx, runContext())).toMatch(/monthly AI budget/);
        expect(ctx.generators[0].generate).not.toHaveBeenCalled();
    });

    test('each person has an hourly allowance of their own', async () => {
        const userId = freshUser();
        for (let n = 0; n < IMAGES_PER_WINDOW; n++) {
            expect(await generateImage({ prompt: 'x' }, context({ userId }), runContext())).toMatch(/will be posted/);
        }
        const ctx = context({ userId });
        expect(await generateImage({ prompt: 'x' }, ctx, runContext())).toMatch(/used their 5 images/);
        expect(ctx.generators[0].generate).not.toHaveBeenCalled();
        // Someone else is unaffected.
        expect(await generateImage({ prompt: 'x' }, context(), runContext())).toMatch(/will be posted/);
    });

    test('scheduled runs share one allowance per guild', async () => {
        const guildId = `g-sched-${++seq}`;
        for (let n = 0; n < IMAGES_PER_WINDOW; n++) {
            await generateImage({ prompt: 'x' }, context({ guildId, userId: null }), runContext());
        }
        expect(await generateImage({ prompt: 'x' }, context({ guildId, userId: null }), runContext()))
            .toMatch(/scheduled tasks have used/);
    });

    test('images asked for in one round are counted before any of them finishes', async () => {
        // A model calls tools in parallel; each call must hold its place before
        // the slow provider call, or all of them pass the checks at once.
        const userId = freshUser();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const slow = { name: 'OpenAI', generate: jest.fn(async () => { await gate; return { image: PNG, mimeType: 'image/png', ledger }; }) };
        const ctx = context({ userId, generators: [slow] });

        const calls = Array.from({ length: MAX_IMAGES_PER_TURN + 2 }, (_, n) => generateImage({ prompt: `p${n}` }, ctx, runContext()));
        release();
        const results = await Promise.all(calls);

        expect(slow.generate).toHaveBeenCalledTimes(MAX_IMAGES_PER_TURN);
        expect(results.filter(text => /will be posted/.test(text))).toHaveLength(MAX_IMAGES_PER_TURN);
        expect(results.filter(text => /at most 2/.test(text))).toHaveLength(2);
        expect(ctx.turn).toEqual({ count: MAX_IMAGES_PER_TURN, pending: 0 });
    });

    test('concurrent turns cannot go past the hourly allowance either', async () => {
        const userId = freshUser();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const slow = { name: 'OpenAI', generate: jest.fn(async () => { await gate; return { image: PNG, mimeType: 'image/png', ledger }; }) };

        const calls = Array.from({ length: IMAGES_PER_WINDOW + 3 }, () =>
            generateImage({ prompt: 'x' }, context({ userId, generators: [slow] }), runContext()));
        release();
        const results = await Promise.all(calls);

        expect(slow.generate).toHaveBeenCalledTimes(IMAGES_PER_WINDOW);
        expect(results.filter(text => /used their 5 images/.test(text))).toHaveLength(3);
    });

    test('a refusal keeps the hour\'s slot, since it can be billed', async () => {
        const userId = freshUser();
        const refusing = drawing({ refused: true, image: undefined });
        for (let n = 0; n < IMAGES_PER_WINDOW; n++) {
            await generateImage({ prompt: 'x' }, context({ userId, generators: [refusing] }), runContext());
        }
        expect(await generateImage({ prompt: 'x' }, context({ userId }), runContext())).toMatch(/used their 5 images/);
    });

    test('a failed call spends no allowance', async () => {
        const userId = freshUser();
        const broken = { name: 'OpenAI', generate: jest.fn(async () => { throw new Error('down'); }) };
        for (let n = 0; n < IMAGES_PER_WINDOW + 2; n++) {
            await generateImage({ prompt: 'x' }, context({ userId, generators: [broken] }), runContext());
        }
        expect(await generateImage({ prompt: 'x' }, context({ userId }), runContext())).toMatch(/will be posted/);
    });
});

describe('the real services', () => {
    test('OpenAI: gpt-image-1, one image, the shape asked for, its usage in the ledger', async () => {
        mockImagesGenerate.mockResolvedValue({
            data: [{ b64_json: PNG.toString('base64') }],
            usage: { input_tokens: 12, output_tokens: 1584 }
        });
        const [openai] = imageGeneratorsFor({ openaiKey: 'sk-test' }, null);

        const made = await openai.generate('a fox', 'portrait');

        expect(mockImagesGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ model: OPENAI_IMAGE_MODEL, prompt: 'a fox', n: 1, size: '1024x1536' }),
            expect.anything()
        );
        expect(made.image.equals(PNG)).toBe(true);
        expect(made.ledger).toEqual({ provider: 'openai', model: OPENAI_IMAGE_MODEL, usage: { inputTokens: 12, outputTokens: 1584 } });
    });

    test('OpenAI: a moderation block is a refusal, not an error', async () => {
        mockImagesGenerate.mockRejectedValue(Object.assign(new Error('blocked'), { status: 400, code: 'moderation_blocked' }));
        const [openai] = imageGeneratorsFor({ openaiKey: 'sk-test' }, null);
        await expect(openai.generate('x', 'square')).resolves.toEqual({ refused: true, ledger: null });
    });

    test('Gemini: the image part, the aspect ratio, and a safety stop as a refusal', async () => {
        mockGenerateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1290 }
        });
        const [gemini] = imageGeneratorsFor({ geminiKey: 'g-test', provider: 'gemini' }, null);

        const made = await gemini.generate('a fox', 'landscape');
        expect(mockGenerateContent.mock.calls[0][0]).toMatchObject({
            model: GEMINI_IMAGE_MODEL,
            config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } }
        });
        expect(made.image.equals(PNG)).toBe(true);
        expect(made.ledger.usage).toEqual({ inputTokens: 8, outputTokens: 1290 });

        mockGenerateContent.mockResolvedValueOnce({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] });
        await expect(gemini.generate('x', 'square')).resolves.toMatchObject({ refused: true });

        mockGenerateContent.mockResolvedValueOnce({ promptFeedback: { blockReason: 'SAFETY' } });
        await expect(gemini.generate('x', 'square')).resolves.toMatchObject({ refused: true });
    });

    test('recorded through the real ledger', async () => {
        mockImagesGenerate.mockResolvedValue({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 5, output_tokens: 1000 } });
        const generators = imageGeneratorsFor({ openaiKey: 'sk-test' }, 'g-ledger');
        const text = await generateImage({ prompt: 'x' }, { guildId: 'g-ledger', userId: freshUser(), generators, turn: { count: 0 } }, runContext());
        await flush();

        expect(text).toMatch(/will be posted/);
        expect(AIUsage.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: 'g-ledger', provider: 'openai', model: OPENAI_IMAGE_MODEL }),
            expect.objectContaining({ $inc: expect.objectContaining({ inputTokens: 5, outputTokens: 1000 }) }),
            expect.anything()
        );
    });
});
