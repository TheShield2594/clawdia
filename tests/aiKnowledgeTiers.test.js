'use strict';

// #840: the knowledge base used to have a cliff in it.
//
// Fifteen entries or fewer and every entry went into every message; the
// sixteenth switched the guild, silently and permanently, to top-five text
// retrieval. Nobody adding a wiki page discovers that rule — they just find the
// bot has forgotten most of what it knew a minute ago. Retrieval now always
// runs, and the small-base behaviour survives as an always-on tier of the few
// newest entries.

const mockFind = jest.fn();
const mockCountDocuments = jest.fn();
jest.mock('../src/models/KnowledgeBase', () => ({
    find: (...args) => mockFind(...args),
    countDocuments: (...args) => mockCountDocuments(...args)
}));

const { retrieveKnowledge, knowledgeSection, buildKnowledgeContext, KB_BACKGROUND_LIMIT } =
    require('../src/services/ai/knowledge');

const entry = (id, title, content = 'body') => ({ _id: id, title, content, tags: [] });

// The two shapes the model is called with: a `$text` query (sorted, limited,
// projected) and the plain recency read.
function stubQueries({ matched = [], recent = [] } = {}) {
    mockFind.mockImplementation((filter) => {
        const chain = { lean: async () => (filter.$text ? matched : recent) };
        chain.limit = () => chain;
        chain.sort = () => chain;
        return chain;
    });
}

beforeEach(() => jest.clearAllMocks());

describe('retrieval', () => {
    test('returns what the question matched, and says so', async () => {
        const hit = entry('1', 'Kitchen rota', 'the kitchen rota is on Tuesdays');
        stubQueries({ matched: [hit], recent: [hit] });

        const result = await retrieveKnowledge('g1', 'when is the kitchen rota?');

        expect(result.matched.map(e => e._id)).toEqual(['1']);
        expect(result.isBackground).toBe(false);
        // The matched entry is not repeated as background.
        expect(result.background).toEqual([]);
        expect(result.entries).toHaveLength(1);
    });

    test('a question that matched nothing still gets the background tier', async () => {
        const recent = [entry('9', 'Server rules'), entry('8', 'Ticket policy')];
        stubQueries({ matched: [], recent });

        const result = await retrieveKnowledge('g1', 'what is the weather like?');

        expect(result.matched).toEqual([]);
        expect(result.isBackground).toBe(true);
        expect(result.background.map(e => e._id)).toEqual(['9', '8']);
    });

    // The behaviour a large guild used to lose entirely at entry sixteen.
    test('a large base gets both tiers: matches first, then the newest few', async () => {
        stubQueries({
            matched: [entry('1', 'Kitchen rota', 'kitchen rota')],
            recent: [entry('50', 'Newest'), entry('49', 'Next'), entry('1', 'Kitchen rota'), entry('48', 'Older')]
        });

        const result = await retrieveKnowledge('g1', 'kitchen rota please');

        expect(result.entries.map(e => e._id)).toEqual(['1', '50', '49', '48']);
        expect(result.background).toHaveLength(KB_BACKGROUND_LIMIT);
    });

    test('the background tier is bounded however large the base is', async () => {
        stubQueries({ matched: [], recent: Array.from({ length: 40 }, (_, i) => entry(String(i), `E${i}`)) });

        const result = await retrieveKnowledge('g1', 'anything at all');

        expect(result.background).toHaveLength(KB_BACKGROUND_LIMIT);
    });

    test('a message with no words worth searching still gets background', async () => {
        stubQueries({ matched: [], recent: [entry('1', 'Rules')] });

        const result = await retrieveKnowledge('g1', 'ok');

        expect(result.matched).toEqual([]);
        expect(result.entries).toHaveLength(1);
    });

    test('a text index that does not exist yet falls back to a capped scan', async () => {
        const scanned = entry('1', 'Kitchen rota', 'kitchen rota lives here');
        mockFind.mockImplementation((filter) => {
            if (filter.$text) throw new Error('no text index');
            const chain = { lean: async () => [scanned] };
            chain.limit = () => chain;
            chain.sort = () => chain;
            return chain;
        });

        const result = await retrieveKnowledge('g1', 'kitchen rota');

        expect(result.matched.map(e => e._id)).toEqual(['1']);
    });
});

describe('the prompt block', () => {
    test('is one item per entry, so the budget can drop them one at a time', () => {
        const section = knowledgeSection([entry('1', 'One'), entry('2', 'Two')]);

        expect(section.items).toHaveLength(2);
        expect(section.items[0]).toContain('**One**');
        expect(section.header).toContain('Reference only');
    });

    test('the background tier says it was not matched to the question', () => {
        const section = knowledgeSection([entry('1', 'One')], { background: true });

        expect(section.header).toContain('not matched to the question');
    });

    test('renders to what it always rendered to', () => {
        const text = buildKnowledgeContext([entry('1', 'One', 'line a\nline b')]);

        expect(text).toContain('> **One**\n> line a\n> line b');
        expect(buildKnowledgeContext([])).toBe('');
    });
});
