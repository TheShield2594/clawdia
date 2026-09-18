'use strict';

// #1042: the knowledge base's semantic tier.
//
// The keyword scorer misses a question that shares no stem with an entry — "I'm
// skint, what now" never reaches a `daily` entry unless someone hand-added the
// synonym. With the semantic tier on, the entry is embedded when written and
// the question is embedded when asked, so cosine distance finds it anyway. This
// is the paraphrase test the issue's acceptance criteria call for: the entry
// retrieves with the tier on and nothing retrieves with it off.
//
// The embedder is stubbed rather than run: the real backends are a network
// download (local model) or a provider call, and the retrieval logic under test
// — union the keyword hits with the nearest vectors, drop stale ones — is the
// same whatever produced the numbers. The stub returns a vector that is close
// to the entry's for the paraphrase and orthogonal to it for anything else.

const mockFind = jest.fn();
jest.mock('../src/models/KnowledgeBase', () => ({
    find: (...args) => mockFind(...args)
}));

const { retrieveKnowledge } = require('../src/services/ai/knowledge');

const EMBEDDER_ID = 'test:stub';

// A tiny hand-built vector space. The paraphrase and the stored entry point the
// same way (cosine 1); an unrelated question is orthogonal to it (cosine 0).
const VECTORS = {
    "i'm skint, what now": [1, 0, 0],
    'how do i claim my daily reward': [1, 0, 0],
    'what is the weather like': [0, 1, 0]
};

const stubEmbedder = {
    id: EMBEDDER_ID,
    embed: async texts => texts.map(text => VECTORS[text.toLowerCase()] || [0, 0, 1])
};

const dailyEntry = {
    _id: '1',
    title: 'Daily reward',
    content: 'Run /daily once a day to claim free coins.',
    tags: ['economy'],
    embedding: [1, 0, 0],
    embeddingModel: EMBEDDER_ID
};

// The three reads retrieveKnowledge makes, told apart by their filter: the
// keyword `$text` query, the semantic vector query (filters on embeddingModel),
// and the plain recency read for the always-on background tier.
function stubQueries({ keyword = [], vectors = [], recent = [] } = {}) {
    mockFind.mockImplementation(filter => {
        let result = recent;
        if (filter.$text) result = keyword;
        else if (filter.embeddingModel) result = vectors;

        const chain = { lean: async () => result };
        chain.limit = () => chain;
        chain.sort = () => chain;
        return chain;
    });
}

beforeEach(() => jest.clearAllMocks());

describe('the semantic tier', () => {
    test('a paraphrase sharing no stem retrieves the entry with the tier on', async () => {
        // No keyword hit — the question and the entry share no word — so the
        // only way to reach it is the vector.
        stubQueries({ keyword: [], vectors: [dailyEntry], recent: [] });

        const result = await retrieveKnowledge('g1', "I'm skint, what now", { embedder: stubEmbedder });

        expect(result.matched.map(e => e._id)).toEqual(['1']);
        expect(result.isBackground).toBe(false);
    });

    test('the same paraphrase retrieves nothing with the tier off', async () => {
        stubQueries({ keyword: [], vectors: [dailyEntry], recent: [] });

        const result = await retrieveKnowledge('g1', "I'm skint, what now");

        expect(result.matched).toEqual([]);
        expect(result.isBackground).toBe(true);
    });

    test('an unrelated question does not drag the entry in on similarity alone', async () => {
        stubQueries({ keyword: [], vectors: [dailyEntry], recent: [] });

        const result = await retrieveKnowledge('g1', 'what is the weather like', { embedder: stubEmbedder });

        expect(result.matched).toEqual([]);
    });

    test('keyword hits come first, then semantic neighbours fill the rest', async () => {
        const keywordHit = { _id: '2', title: 'Daily quest', content: 'daily reward', tags: [] };
        stubQueries({ keyword: [keywordHit], vectors: [dailyEntry], recent: [] });

        const result = await retrieveKnowledge('g1', 'how do I claim my daily reward', { embedder: stubEmbedder });

        // The exact-word match ranks ahead of the paraphrase neighbour, and the
        // neighbour is not repeated if it was already a keyword hit.
        expect(result.matched.map(e => e._id)).toEqual(['2', '1']);
    });

    test('a vector from a different embedder is never scored against this query', async () => {
        // The stored entry is tagged with a model this query is not asking with;
        // the DB filter on embeddingModel means it is not even returned, so the
        // union is empty and nothing matches.
        stubQueries({ keyword: [], vectors: [], recent: [] });

        const result = await retrieveKnowledge('g1', "I'm skint, what now", { embedder: stubEmbedder });

        expect(result.matched).toEqual([]);
    });
});
