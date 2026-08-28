'use strict';

// #839: an image attached to a Discord message reaching the model.
//
// `message.attachments` was never read, so "what's wrong with this?" alongside
// a screenshot arrived at the provider as five words and no picture, and the
// answer was a guess presented as an observation. These cover the three halves
// of the fix: which attachments are eligible and what they cost, which models
// may be shown one, and the wire shape each provider puts them in.

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({ get: (...args) => mockAxiosGet(...args) }));
jest.mock('../src/utils/outboundGuard', () => ({
    guardedAgents: () => ({ httpAgent: 'guarded' }),
    assertPublicHttpUrl: jest.fn()
}));

const vision = require('../src/services/ai/vision');
const { collectImages, loadImages, visionNotice, MAX_IMAGES, MAX_IMAGE_BYTES } = vision;

const openai = require('../src/services/ai/providers/openai');
const anthropic = require('../src/services/ai/providers/anthropic');
const gemini = require('../src/services/ai/providers/gemini');
const ollama = require('../src/services/ai/providers/ollama');
const openrouter = require('../src/services/ai/providers/openrouter');
const { supportsVision } = require('../src/services/ai/providers');

function attachment(overrides = {}) {
    return {
        url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
        contentType: 'image/png',
        name: 'shot.png',
        size: 1024,
        ...overrides
    };
}

// Discord hands these over as a Collection; a Map is the same shape for
// everything this reads.
function messageWith(...attachments) {
    return { attachments: new Map(attachments.map((a, i) => [String(i), a])) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosGet.mockResolvedValue({ data: Buffer.from('PNGBYTES') });
});

describe('which attachments are eligible', () => {
    test('an image is collected with its type and URL', () => {
        const { images, skipped } = collectImages(messageWith(attachment()));

        expect(skipped).toBe(0);
        expect(images).toEqual([{
            url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
            mimeType: 'image/png',
            name: 'shot.png',
            size: 1024
        }]);
    });

    test('a non-image attachment is ignored rather than counted as missed', () => {
        const { images, skipped } = collectImages(messageWith(
            attachment({ contentType: 'application/zip', name: 'logs.zip' })
        ));

        expect(images).toHaveLength(0);
        // Nothing was lost: the user attached a zip and asked something else.
        expect(skipped).toBe(0);
    });

    // SVG is a document with a script in it, which is why the list is an allow
    // list rather than `startsWith('image/')`.
    test('an SVG is not an image for this purpose', () => {
        const { images } = collectImages(messageWith(
            attachment({ contentType: 'image/svg+xml', name: 'diagram.svg' })
        ));

        expect(images).toHaveLength(0);
    });

    test('an unlabelled attachment falls back to its extension', () => {
        const { images } = collectImages(messageWith(
            attachment({ contentType: null, name: 'holiday.JPEG' })
        ));

        expect(images).toHaveLength(1);
        expect(images[0].mimeType).toBe('image/jpeg');
    });

    test('past the per-message cap the rest are counted as skipped', () => {
        const many = Array.from({ length: MAX_IMAGES + 2 }, (_, i) =>
            attachment({ name: `shot${i}.png` }));

        const { images, skipped } = collectImages(messageWith(...many));

        expect(images).toHaveLength(MAX_IMAGES);
        expect(skipped).toBe(2);
    });

    test('an image larger than the cap is left behind', () => {
        const { images, skipped } = collectImages(messageWith(
            attachment({ size: MAX_IMAGE_BYTES + 1 })
        ));

        expect(images).toHaveLength(0);
        expect(skipped).toBe(1);
    });

    test('a message with no attachments collects nothing', () => {
        expect(collectImages({}).images).toHaveLength(0);
    });
});

describe('loading the bytes', () => {
    test('a supported model gets base64 fetched through the SSRF guard', async () => {
        const found = collectImages(messageWith(attachment()));

        const loaded = await loadImages(found, { supported: true });

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet.mock.calls[0][1]).toMatchObject({ httpAgent: 'guarded', responseType: 'arraybuffer' });
        expect(loaded.images[0].base64).toBe(Buffer.from('PNGBYTES').toString('base64'));
        expect(loaded.unsupported).toBe(0);
    });

    test('a model that cannot see is not worth the round trip', async () => {
        const found = collectImages(messageWith(attachment()));

        const loaded = await loadImages(found, { supported: false });

        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(loaded.images).toHaveLength(0);
        expect(loaded.unsupported).toBe(1);
    });

    test('a body larger than Discord declared is dropped after the fetch', async () => {
        mockAxiosGet.mockResolvedValue({ data: Buffer.alloc(MAX_IMAGE_BYTES + 1) });

        const loaded = await loadImages(collectImages(messageWith(attachment())), { supported: true });

        expect(loaded.images).toHaveLength(0);
        expect(loaded.skipped).toBe(1);
    });

    test('an attachment URL pointing somewhere private is refused before the fetch', async () => {
        const { assertPublicHttpUrl } = require('../src/utils/outboundGuard');
        assertPublicHttpUrl.mockImplementationOnce(() => { throw new Error('private address'); });

        const found = collectImages(messageWith(attachment({ url: 'http://169.254.169.254/latest' })));
        const loaded = await loadImages(found, { supported: true });

        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(loaded.images).toHaveLength(0);
        expect(loaded.skipped).toBe(1);
    });

    test('a failed fetch costs its image and nothing else', async () => {
        mockAxiosGet
            .mockRejectedValueOnce(new Error('gone'))
            .mockResolvedValueOnce({ data: Buffer.from('OK') });

        const found = collectImages(messageWith(attachment(), attachment({ name: 'two.png' })));
        const loaded = await loadImages(found, { supported: true });

        expect(loaded.images).toHaveLength(1);
        expect(loaded.skipped).toBe(1);
    });
});

describe('the note the model is given about what it cannot see', () => {
    test('says the model is the reason when the model is the reason', () => {
        expect(visionNotice({ unsupported: 1 })).toContain('cannot read images');
    });

    test('says the attachment is the reason otherwise', () => {
        expect(visionNotice({ skipped: 2 })).toContain('2 image attachments');
    });

    test('is nothing at all when nothing was missed', () => {
        expect(visionNotice({})).toBe('');
    });
});

describe('which models may be shown an image', () => {
    test.each([
        ['gpt-4o-mini', true],
        ['gpt-4.1', true],
        ['o1', true],
        // The small reasoning models take text only, and answer an image with
        // a 400 rather than by ignoring it.
        ['o1-mini', false],
        ['o3-mini', false],
        ['gpt-3.5-turbo', false]
    ])('openai %s → %s', (model, expected) => {
        expect(openai.supportsVision(model)).toBe(expected);
    });

    test('every current Claude can see; the retired ones cannot', () => {
        expect(anthropic.supportsVision('claude-haiku-4-5')).toBe(true);
        expect(anthropic.supportsVision('claude-2.1')).toBe(false);
    });

    test('Gemini can, except the text-only and non-chat endpoints', () => {
        expect(gemini.supportsVision('gemini-2.0-flash')).toBe(true);
        expect(gemini.supportsVision('gemini-pro')).toBe(false);
        expect(gemini.supportsVision('text-embedding-004')).toBe(false);
    });

    test('Ollama is a name match, and an unrecognised model stays text-only', () => {
        expect(ollama.supportsVision('llava')).toBe(true);
        expect(ollama.supportsVision('llama3.2-vision')).toBe(true);
        expect(ollama.supportsVision('llama3.2')).toBe(false);
        // The one member of an otherwise multimodal family with no vision tower.
        expect(ollama.supportsVision('gemma3:1b')).toBe(false);
        expect(ollama.supportsVision('gemma3:4b')).toBe(true);
    });

    test('OpenRouter asks the vendor the id names', () => {
        expect(openrouter.supportsVision('openai/gpt-4o-mini')).toBe(true);
        expect(openrouter.supportsVision('openai/o3-mini')).toBe(false);
        expect(openrouter.supportsVision('google/gemini-2.0-flash:free')).toBe(true);
        expect(openrouter.supportsVision('meta-llama/llama-4-scout')).toBe(true);
        expect(openrouter.supportsVision('meta-llama/llama-3.1-8b-instruct')).toBe(false);
    });

    test('the registry answers for a provider, and text-only for one it has never heard of', () => {
        expect(supportsVision('anthropic', 'claude-haiku-4-5')).toBe(true);
        expect(supportsVision('nonesuch', 'whatever')).toBe(false);
    });
});
