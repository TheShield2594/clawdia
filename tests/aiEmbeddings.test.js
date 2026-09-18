'use strict';

// #1042: the embedding backend's pure parts and its off-by-default contract.
// The three backends themselves (a local model download, two provider calls)
// are not exercised here — they need a network — but the wiring that decides
// whether to build one at all, and the cosine the retrieval tier ranks with,
// are plain functions worth pinning.

const { cosineSimilarity, semanticConfig, embedderId, getEmbedder } =
    require('../src/services/ai/embeddings');

describe('cosineSimilarity', () => {
    test('is 1 for identical direction and 0 for orthogonal', () => {
        expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1);
        expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    });

    test('is 0 for mismatched lengths or empty or zero vectors', () => {
        expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
        expect(cosineSimilarity([], [])).toBe(0);
        expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });
});

describe('semanticConfig', () => {
    test('is null unless the tier is explicitly enabled', () => {
        expect(semanticConfig({})).toBeNull();
        expect(semanticConfig({ semanticRetrieval: { enabled: false } })).toBeNull();
        expect(semanticConfig({ semanticRetrieval: { enabled: true } }))
            .toEqual({ provider: 'local', localModel: 'Xenova/all-MiniLM-L6-v2' });
    });
});

describe('embedderId', () => {
    test('names the space each backend embeds into, so vectors are not compared across them', () => {
        expect(embedderId({ provider: 'local', localModel: 'Xenova/all-MiniLM-L6-v2' }))
            .toBe('local:Xenova/all-MiniLM-L6-v2');
        expect(embedderId({ provider: 'openai' })).toBe('openai:text-embedding-3-small');
        expect(embedderId({ provider: 'gemini' })).toBe('gemini:text-embedding-004');
        expect(embedderId(null)).toBeNull();
    });
});

describe('getEmbedder', () => {
    test('returns null when the tier is off, without touching any backend', async () => {
        await expect(getEmbedder({})).resolves.toBeNull();
    });

    test('returns null for a provider backend with no key configured', async () => {
        const priorOpenai = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            const embedder = await getEmbedder({ semanticRetrieval: { enabled: true, provider: 'openai' } });
            expect(embedder).toBeNull();
        } finally {
            if (priorOpenai !== undefined) process.env.OPENAI_API_KEY = priorOpenai;
        }
    });
});
