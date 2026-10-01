'use strict';

// Storage and load window agree (#823). appendHistory used to retain max*2
// messages while loadHistory only ever read the last max — half of every
// conversation's stored history was persisted and never loaded.

jest.mock('../src/models/Conversation', () => {
    const store = { doc: null };
    function Conversation(fields) {
        Object.assign(this, fields);
        this.save = async () => { store.doc = this; };
    }
    Conversation.findOne = jest.fn(async () => store.doc);
    Conversation.deleteOne = jest.fn(async () => { store.doc = null; });
    Conversation.__store = store;
    return Conversation;
});

jest.mock('../src/models/ConversationLog', () => ({ insertMany: jest.fn(async docs => docs) }));

const Conversation = require('../src/models/Conversation');
const ConversationLog = require('../src/models/ConversationLog');
const { loadHistory, appendHistory } = require('../src/services/ai/history');

beforeEach(() => {
    Conversation.__store.doc = null;
    jest.clearAllMocks();
});

async function appendExchanges(count, max) {
    for (let i = 1; i <= count; i++) {
        await appendHistory('g', 'c', 'u', `question ${i}`, `answer ${i}`, max);
    }
}

test('storage is trimmed to exactly what loadHistory reads', async () => {
    await appendExchanges(10, 6);

    expect(Conversation.__store.doc.messages).toHaveLength(6);

    const { messages } = await loadHistory('g', 'c', 'u', 6);
    expect(messages).toHaveLength(6);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'answer 10' });
    expect(messages[0]).toEqual({ role: 'user', content: 'question 8' });
});

test('nothing persisted goes unloaded', async () => {
    await appendExchanges(20, 8);

    const stored = Conversation.__store.doc.messages.map(m => m.content);
    const { messages } = await loadHistory('g', 'c', 'u', 8);
    expect(messages.map(m => m.content)).toEqual(stored);
});

test('a short conversation is kept whole', async () => {
    await appendExchanges(2, 20);

    expect(Conversation.__store.doc.messages).toHaveLength(4);
    const { messages } = await loadHistory('g', 'c', 'u', 20);
    expect(messages).toHaveLength(4);
});

// The searchable log (ai.conversationSearch) sits beside the retention window,
// not inside it: what the window drops is exactly what the log is for.
test('nothing is logged for search unless the guild asked', async () => {
    await appendExchanges(3, 4);
    expect(ConversationLog.insertMany).not.toHaveBeenCalled();
});

test('with search on, both turns are logged, in order, even with no context window', async () => {
    await appendHistory('g', 'c', 'u', 'where did I park', 'Level 3, bay 12', 0, null, { archive: true });

    const [docs] = ConversationLog.insertMany.mock.calls[0];
    expect(docs.map(d => [d.role, d.content])).toEqual([['user', 'where did I park'], ['assistant', 'Level 3, bay 12']]);
    expect(docs[0]).toMatchObject({ guildId: 'g', channelId: 'c', userId: 'u' });
    expect(docs[1].createdAt.getTime()).toBeGreaterThan(docs[0].createdAt.getTime());
    expect(Conversation.__store.doc).toBeNull();
});

test('a log write that fails does not fail the turn', async () => {
    ConversationLog.insertMany.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(appendHistory('g', 'c', 'u', 'q', 'a', 4, null, { archive: true })).resolves.toBeUndefined();
    expect(Conversation.__store.doc.messages).toHaveLength(2);
});
