'use strict';

// The tools that make the bot an assistant rather than a channel helper: a web
// search over the operator's SearXNG, and notes the model writes to the
// knowledge base so a later conversation starts from what it worked out.

jest.mock('../src/models/KnowledgeBase', () => ({
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(async () => ({}))
}));
jest.mock('../src/models/ConversationLog', () => ({ find: jest.fn() }));
jest.mock('../src/services/ai/embeddings', () => ({
    embedForStorage: jest.fn(async () => null),
    cosineSimilarity: jest.fn()
}));

const KnowledgeBase = require('../src/models/KnowledgeBase');
const ConversationLog = require('../src/models/ConversationLog');
const { embedForStorage } = require('../src/services/ai/embeddings');
const {
    buildAgentTools,
    buildAgentToolsAddendum,
    searchWeb,
    readWebpage,
    htmlToText,
    searchConversations,
    searxngBaseUrl,
    saveNote,
    noteKey,
    MAX_LEARNED_NOTES,
    LEARNED_TAG
} = require('../src/services/ai/agentTools');
const { createUnattendedConfirmer } = require('../src/services/ai/mcp/approval');
const { buildAnthropicMcpParams, resolveMcpServers } = require('../src/config/mcpServers');

const ORIGINAL_SEARXNG = process.env.SEARXNG_URL;

beforeEach(() => {
    jest.clearAllMocks();
    process.env.SEARXNG_URL = 'http://searxng:8080/';
    KnowledgeBase.findOne.mockReturnValue({ lean: async () => null });
    KnowledgeBase.countDocuments.mockResolvedValue(0);
});

afterAll(() => {
    if (ORIGINAL_SEARXNG === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = ORIGINAL_SEARXNG;
});

const names = tools => tools.map(tool => tool.name);

describe('which agent tools a turn gets', () => {
    test('none unless the guild switched them on', () => {
        expect(buildAgentTools({}, { guildId: 'g1', canManage: true })).toEqual([]);
    });

    test('web search needs the guild switch and the operator\'s SEARXNG_URL', () => {
        expect(names(buildAgentTools({ webSearchEnabled: true }, { guildId: 'g1' }))).toEqual(['web_search', 'read_webpage']);
        delete process.env.SEARXNG_URL;
        // Reading a page needs no search engine.
        expect(names(buildAgentTools({ webSearchEnabled: true }, { guildId: 'g1' }))).toEqual(['read_webpage']);
    });

    test('learning is only for members who could edit the knowledge base by hand', () => {
        const ai = { learningEnabled: true };
        expect(buildAgentTools(ai, { guildId: 'g1', canManage: false })).toEqual([]);
        expect(names(buildAgentTools(ai, { guildId: 'g1', canManage: true }))).toEqual(['learn']);
    });

    test('a scheduled run gets the search but never writes a note', () => {
        const ai = { webSearchEnabled: true, learningEnabled: true };
        expect(names(buildAgentTools(ai, { guildId: 'g1', canManage: true, unattended: true }))).toEqual(['web_search', 'read_webpage']);
    });

    test('the search needs no approval and says it only reads', () => {
        const [search] = buildAgentTools({ webSearchEnabled: true }, { guildId: 'g1' });
        expect(search.confirm).toBe(false);
        expect(search.annotations.readOnlyHint).toBe(true);
    });

    test('the model is told about the tools it has, and only those', () => {
        expect(buildAgentToolsAddendum([])).toBe('');
        const text = buildAgentToolsAddendum([{ name: 'web_search' }]);
        expect(text).toMatch(/web_search/);
        expect(text).not.toMatch(/\blearn\b/);
    });
});

describe('searxngBaseUrl', () => {
    test('takes an http(s) URL and drops the trailing slash', () => {
        expect(searxngBaseUrl('https://search.example.com/')).toBe('https://search.example.com');
        expect(searxngBaseUrl('http://10.0.0.5:8888')).toBe('http://10.0.0.5:8888');
    });

    test('refuses anything else, rather than dialling it', () => {
        expect(searxngBaseUrl('')).toBeNull();
        expect(searxngBaseUrl('file:///etc/passwd')).toBeNull();
        expect(searxngBaseUrl('http://user:pass@searxng')).toBeNull();
        expect(searxngBaseUrl('not a url')).toBeNull();
    });
});

describe('web_search', () => {
    const respond = (status, body) => jest.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }));

    test('asks SearXNG for JSON and labels what comes back as third-party data', async () => {
        const fetchImpl = respond(200, {
            results: [
                { title: 'Release notes', url: 'https://example.com/a', content: 'Version 2 is out', publishedDate: '2026-09-30T10:00:00' },
                { title: 'Duplicate', url: 'https://example.com/a', content: 'same page again' },
                { title: 'Second', url: 'https://example.com/b', content: '' }
            ],
            answers: ['42']
        });
        const text = await searchWeb({ query: 'what changed', timeRange: 'week' }, { baseUrl: 'http://searxng:8080', fetchImpl });

        const url = fetchImpl.mock.calls[0][0];
        expect(url.searchParams.get('q')).toBe('what changed');
        expect(url.searchParams.get('format')).toBe('json');
        expect(url.searchParams.get('time_range')).toBe('week');

        expect(text).toMatch(/not instructions/);
        expect(text).toMatch(/Direct answer: 42/);
        expect(text).toMatch(/Release notes \(2026-09-30\)/);
        expect(text.match(/example\.com\/a/g)).toHaveLength(1);
        expect(text).toMatch(/example\.com\/b/);
    });

    test('ignores a time range it does not know', async () => {
        const fetchImpl = respond(200, { results: [] });
        await searchWeb({ query: 'x', timeRange: 'decade' }, { baseUrl: 'http://s', fetchImpl });
        expect(fetchImpl.mock.calls[0][0].searchParams.has('time_range')).toBe(false);
    });

    test('names the SearXNG setting when JSON output is switched off', async () => {
        const text = await searchWeb({ query: 'x' }, { baseUrl: 'http://s', fetchImpl: respond(403, 'Forbidden') });
        expect(text).toMatch(/JSON output is switched off/);
    });

    test('every failure is an answer the model can use, never a throw', async () => {
        const down = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
        await expect(searchWeb({ query: 'x' }, { baseUrl: 'http://s', fetchImpl: down })).resolves.toMatch(/could not be reached/);
        await expect(searchWeb({ query: 'x' }, { baseUrl: 'http://s', fetchImpl: respond(502, '') })).resolves.toMatch(/status 502/);
        await expect(searchWeb({ query: 'x' }, { baseUrl: 'http://s', fetchImpl: respond(200, '<html>') })).resolves.toMatch(/unreadable/);
        await expect(searchWeb({ query: 'x' }, { baseUrl: null })).resolves.toMatch(/not configured/);
        await expect(searchWeb({ query: '  ' }, { baseUrl: 'http://s' })).resolves.toMatch(/empty/);
    });

    test('says plainly when there is nothing', async () => {
        const text = await searchWeb({ query: 'zzz' }, { baseUrl: 'http://s', fetchImpl: respond(200, { results: [] }) });
        expect(text).toMatch(/No web results/);
    });
});

describe('learn', () => {
    const context = { guildId: 'g1', userId: 'u1', ai: {} };

    test('writes a tagged note keyed by its title', async () => {
        const result = await saveNote({ title: 'Adding a class to the calendar', content: 'Use the School calendar.', tags: ['Calendar'] }, context);

        const [filter, update, options] = KnowledgeBase.updateOne.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', sourceKey: 'g1:learned:adding-a-class-to-the-calendar' });
        expect(update.$set).toMatchObject({ title: 'Adding a class to the calendar', addedBy: 'u1', tags: [LEARNED_TAG, 'calendar'] });
        expect(options).toEqual({ upsert: true });
        expect(result).toMatch(/Saved a note/);
    });

    test('learning the same thing again rewrites the note rather than adding one', async () => {
        KnowledgeBase.findOne.mockReturnValue({ lean: async () => ({ _id: 'n1' }) });
        KnowledgeBase.countDocuments.mockResolvedValue(MAX_LEARNED_NOTES);

        const result = await saveNote({ title: 'Adding a class to the calendar', content: 'Better steps.' }, context);
        expect(KnowledgeBase.updateOne).toHaveBeenCalled();
        expect(result).toMatch(/Updated your note/);
    });

    test('a new note past the ceiling is refused', async () => {
        KnowledgeBase.countDocuments.mockResolvedValue(MAX_LEARNED_NOTES);
        const result = await saveNote({ title: 'Something new', content: 'x' }, context);
        expect(KnowledgeBase.updateOne).not.toHaveBeenCalled();
        expect(result).toMatch(/already has/);
    });

    test('carries the semantic vector when the guild has that tier on', async () => {
        embedForStorage.mockResolvedValueOnce({ embedding: [0.1, 0.2], embeddingModel: 'local:x' });
        await saveNote({ title: 't', content: 'c' }, context);
        expect(KnowledgeBase.updateOne.mock.calls[0][1].$set).toMatchObject({ embedding: [0.1, 0.2], embeddingModel: 'local:x' });
    });

    test('needs a title and content', async () => {
        await expect(saveNote({ title: '', content: 'x' }, context)).resolves.toMatch(/needs a title/);
        expect(KnowledgeBase.updateOne).not.toHaveBeenCalled();
    });

    test('a title of only punctuation still gets a key', () => {
        expect(noteKey('g1', '!!!')).toBe('g1:learned:note');
    });
});

describe('approving tools in a scheduled run', () => {
    const servers = [{
        name: 'fastmail',
        url: 'https://api.fastmail.com/mcp',
        confirmTools: ['create_event'],
        unattendedTools: ['create_event']
    }];

    test('runs only the tools the connection lists', async () => {
        const confirm = createUnattendedConfirmer(servers);
        await expect(confirm({ server: 'fastmail', tool: 'create_event' })).resolves.toEqual({ approved: true });
        await expect(confirm({ server: 'fastmail', tool: 'delete_event' })).resolves.toMatchObject({ approved: false });
        await expect(confirm({ server: 'github', tool: 'create_event' })).resolves.toMatchObject({ approved: false });
    });

    test('never approves one of the bot\'s own tools, whatever a connection is named', async () => {
        const confirm = createUnattendedConfirmer([{
            name: 'clawdia', url: 'https://example.com/mcp', unattendedTools: ['schedule_task']
        }]);
        await expect(confirm({ server: 'clawdia', tool: 'schedule_task' })).resolves.toMatchObject({ approved: false });
    });

    test('the list is the bot\'s own, and is kept off the Anthropic request', () => {
        const [server] = resolveMcpServers(servers);
        expect(server.toolset.unattended_tools).toEqual(['create_event']);
        const [sent] = buildAnthropicMcpParams(servers).tools;
        expect(sent).not.toHaveProperty('unattended_tools');
        expect(sent).not.toHaveProperty('confirm_tools');
    });
});

describe('read_webpage', () => {
    const page = (body, { status = 200, type = 'text/html; charset=utf-8' } = {}) => jest.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => (name === 'content-type' ? type : null) },
        body: require('stream').Readable.toWeb(require('stream').Readable.from([Buffer.from(body)])),
    }));

    test('reads the text of a page through the SSRF guard', async () => {
        const { guardedDispatcher } = require('../src/utils/outboundGuard');
        const requestImpl = page('<html><head><title>Release &amp; notes</title><script>evil()</script></head>'
            + '<body><nav>menu</nav><h1>Version 2</h1><p>It is out&nbsp;now.</p><ul><li>Faster</li></ul></body></html>');
        const text = await readWebpage({ url: 'https://example.com/notes' }, { requestImpl });

        expect(requestImpl.mock.calls[0][1].dispatcher).toBe(guardedDispatcher());
        expect(text).toMatch(/not instructions/);
        expect(text).toMatch(/"Release & notes"/);
        expect(text).toMatch(/Version 2/);
        expect(text).toMatch(/It is out now\./);
        expect(text).toMatch(/- Faster/);
        expect(text).not.toMatch(/evil|menu/);
    });

    test('refuses a private address before any request goes out', async () => {
        const requestImpl = page('secret');
        for (const url of ['http://127.0.0.1:8080/admin', 'http://169.254.169.254/latest', 'file:///etc/passwd', 'not a url']) {
            await expect(readWebpage({ url }, { requestImpl })).resolves.toMatch(/Nothing was read/);
        }
        expect(requestImpl).not.toHaveBeenCalled();
    });

    test('says what it got instead of reading something that is not text', async () => {
        await expect(readWebpage({ url: 'https://example.com/a.png' }, { requestImpl: page('x', { type: 'image/png' }) }))
            .resolves.toMatch(/image\/png, not a page of text/);
        await expect(readWebpage({ url: 'https://example.com/x' }, { requestImpl: page('', { status: 404 }) }))
            .resolves.toMatch(/status 404/);
        const down = jest.fn(async () => { throw new Error('ENOTFOUND'); });
        await expect(readWebpage({ url: 'https://nowhere.example' }, { requestImpl: down })).resolves.toMatch(/could not be fetched/);
    });

    test('a long page is cut, and says so', async () => {
        const text = await readWebpage({ url: 'https://example.com/long' }, { requestImpl: page(`<p>${'word '.repeat(5000)}</p>`) });
        expect(text).toMatch(/the page goes on/);
    });

    test('decodes numeric entities and keeps block breaks', () => {
        expect(htmlToText('<p>caf&#233;</p><p>&#x2014;done</p>').text).toBe('café\n—done');
    });
});

describe('search_conversations', () => {
    const query = hits => {
        const chain = { sort: jest.fn(() => chain), limit: jest.fn(() => chain), lean: jest.fn(async () => hits) };
        ConversationLog.find.mockReturnValue(chain);
        return chain;
    };

    test('is only offered with the guild switch on, for a known member, and never unattended', () => {
        expect(buildAgentTools({ conversationSearch: true }, { guildId: 'g1' })).toEqual([]);
        expect(names(buildAgentTools({ conversationSearch: true }, { guildId: 'g1', userId: 'u1' }))).toEqual(['search_conversations']);
        expect(buildAgentTools({ conversationSearch: true }, { guildId: 'g1', userId: 'u1', unattended: true })).toEqual([]);
    });

    test('searches only the asker\'s own turns, and lists them oldest first', async () => {
        query([
            { role: 'assistant', content: 'Booked the Lisbon flight for the 12th.', createdAt: new Date('2026-08-02') },
            { role: 'user', content: 'Can you look at flights to Lisbon?', createdAt: new Date('2026-08-01') }
        ]);
        const text = await searchConversations({ query: 'lisbon flight', userId: 'someone-else' }, { guildId: 'g1', userId: 'u1' });

        expect(ConversationLog.find.mock.calls[0][0]).toEqual({ guildId: 'g1', userId: 'u1', $text: { $search: 'lisbon flight' } });
        expect(text.indexOf('2026-08-01')).toBeLessThan(text.indexOf('2026-08-02'));
        expect(text).toMatch(/They said: Can you look at flights/);
        expect(text).toMatch(/You answered: Booked/);
    });

    test('says so when nothing matches, or the search fails', async () => {
        query([]);
        await expect(searchConversations({ query: 'zzz' }, { guildId: 'g1', userId: 'u1' })).resolves.toMatch(/Nothing in your past/);
        ConversationLog.find.mockImplementation(() => { throw new Error('no text index'); });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(searchConversations({ query: 'x' }, { guildId: 'g1', userId: 'u1' })).resolves.toMatch(/failed/);
    });
});
