'use strict';

// Nothing the AI transport posts may ping anybody.
//
// Every message it sends is assembled from text the bot did not write — the
// model's own output, an MCP server's progress note or tool result, the title
// of a knowledge entry — and none of it went out with an `allowedMentions` of
// any kind. A model talked into typing `@everyone`, or a server that names a
// tool it, was a live mention in a channel with this bot's name on it.
//
// The reply ping is the one mention the transport does mean, and it survives:
// specifying allowedMentions at all turns Discord's `replied_user` default off,
// so it has to be asked for back.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(() => ({ lean: async () => null }))
}));

jest.mock('../src/services/ai/knowledge', () => ({
    retrieveKnowledge: jest.fn(async () => ({ entries: [], isBackground: false })),
    buildKnowledgeContext: jest.fn(() => '')
}));

jest.mock('../src/services/ai/history', () => ({
    loadHistory: jest.fn(async () => ({ messages: [] })),
    appendHistory: jest.fn(async () => {}),
    clearHistory: jest.fn(async () => {})
}));

jest.mock('../src/services/ai/mcp/resources', () => ({
    retrieveMcpKnowledge: jest.fn(async () => null)
}));

jest.mock('../src/services/ai/mcp/usage', () => ({
    recordToolCalls: jest.fn(async () => {})
}));

jest.mock('../src/services/ai/providers', () => ({
    providers: new Map([['mock', { name: 'mock', label: 'Mock' }]]),
    mcpMode: () => 'client'
}));

const mockStream = jest.fn();
const mockComplete = jest.fn();
jest.mock('../src/services/ai', () => ({
    resolveProviderConfig: aiSettings => ({
        provider: 'mock', model: 'mock-1', temperature: 0.7, maxTokens: 512,
        apiKey: aiSettings.apiKey === null ? null : 'k', baseUrl: null,
        mcpServers: [],
        rateLimit: { perUser: 0, perChannel: 0, windowMin: 10 }
    }),
    streamCompletion: (...args) => mockStream(...args),
    getCompletion: (...args) => mockComplete(...args),
    DEFAULT_MODELS: { mock: 'mock-1' }
}));

const { handleAIChat } = require('../src/services/ai/discordChat');

const SETTINGS = { provider: 'mock', streaming: true, actionsEnabled: false, maxHistory: 20 };

function fakeMessage(content = 'hello') {
    const sent = [];
    const emit = payload => {
        const msg = {
            payload,
            content: typeof payload === 'string' ? payload : payload?.content ?? '',
            edit: jest.fn(async next => { msg.edited = next; return msg; }),
            delete: jest.fn(async () => msg)
        };
        sent.push(msg);
        return msg;
    };

    const message = {
        content,
        author: { id: 'u1' },
        guild: { id: 'g1' },
        channel: {
            id: 'c1',
            send: jest.fn(async payload => emit(payload)),
            sendTyping: jest.fn(async () => {})
        },
        reply: jest.fn(async payload => emit(payload))
    };
    return { message, sent };
}

// Every payload the transport handed to Discord, by whichever route: the
// first post of a message, and every edit made to it afterwards.
function everyPayload(message, sent) {
    const posts = [
        ...message.reply.mock.calls,
        ...message.channel.send.mock.calls
    ].map(call => call[0]);

    const edits = sent.flatMap(msg => msg.edit.mock.calls).map(call => call[0]);

    return [...posts, ...edits];
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStream.mockImplementation(async function* () { yield 'an answer'; });
    mockComplete.mockResolvedValue('an answer');
});

describe('what reaches Discord', () => {
    test('every message carries a mention policy, none of them parse anything', async () => {
        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        const payloads = everyPayload(message, sent);
        expect(payloads.length).toBeGreaterThan(0);
        for (const payload of payloads) {
            expect(typeof payload).toBe('object');
            expect(payload.allowedMentions).toBeDefined();
            expect(payload.allowedMentions.parse).toEqual([]);
        }
    });

    test('the reply still notifies the person who asked', async () => {
        // The one mention the transport means. Specifying allowedMentions at
        // all turns Discord's replied_user default off, so it is set back on.
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        expect(message.reply).toHaveBeenCalledWith(
            expect.objectContaining({ allowedMentions: { parse: [], repliedUser: true } })
        );
    });

    test('a channel send is not a reply and pings nobody at all', async () => {
        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        for (const [payload] of message.channel.send.mock.calls) {
            expect(payload.allowedMentions).toEqual({ parse: [] });
        }
    });

    test('a model that types @everyone does not get to say it', async () => {
        mockStream.mockImplementation(async function* () {
            yield '@everyone the deploy is broken';
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        // The text is posted as written — it is the model's answer, and
        // rewriting it would be lying about what the model said — but Discord
        // is told to parse no mentions out of it.
        const carried = everyPayload(message, sent).filter(p => (p.content || '').includes('@everyone'));
        expect(carried.length).toBeGreaterThan(0);
        for (const payload of carried) expect(payload.allowedMentions.parse).toEqual([]);
    });

    test('the non-streaming path is covered too', async () => {
        const { message, sent } = fakeMessage();
        await handleAIChat(message, { ...SETTINGS, streaming: false });

        const payloads = everyPayload(message, sent);
        expect(payloads.length).toBeGreaterThan(0);
        for (const payload of payloads) expect(payload.allowedMentions.parse).toEqual([]);
    });

    test('a refusal before the provider is reached carries it as well', async () => {
        // The early exits — no API key, !reset, a spent rate limit — are the
        // paths most likely to be added to later without thinking about this.
        const { message } = fakeMessage('!reset');
        await handleAIChat(message, SETTINGS);

        expect(message.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'Conversation history cleared.',
                allowedMentions: { parse: [], repliedUser: true }
            })
        );
    });

    test('an error report replaces the placeholder without pinging', async () => {
        // Part of an answer, then the provider falls over — which is the
        // shape a stream actually fails in. 400 is not retryable, so the
        // report below is what the channel is left with.
        mockStream.mockImplementation(async function* () {
            yield 'starting to answ';
            throw Object.assign(new Error('nope'), { status: 400 });
        });

        const { message, sent } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        const placeholder = sent[0];
        expect(placeholder.edited).toEqual(
            expect.objectContaining({ allowedMentions: { parse: [] } })
        );
    });

    test('a file-only message keeps its files and gains the policy', async () => {
        mockStream.mockImplementation(async function* (args) {
            args.onToolEvent({ type: 'start', id: 1, server: 'github', tool: 'chart' });
            args.onToolEvent({
                type: 'attachment', id: 1, server: 'github', tool: 'chart',
                buffer: Buffer.from('png'), name: 'chart-1.png'
            });
            args.onToolEvent({ type: 'end', id: 1, server: 'github', tool: 'chart', durationMs: 10, ok: true });
            yield 'here it is';
        });

        const { message } = fakeMessage();
        await handleAIChat(message, SETTINGS);

        const withFiles = message.channel.send.mock.calls
            .map(call => call[0])
            .find(payload => payload.files);

        expect(withFiles.files).toHaveLength(1);
        expect(withFiles.allowedMentions).toEqual({ parse: [] });
    });
});

describe('the policy cannot be skipped by writing the shorter form', () => {
    test('no outbound call in the transport bypasses the helpers', () => {
        // The helpers are only a guarantee for as long as everything goes
        // through them, and the shorter form is the one a new call site
        // reaches for.
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'services', 'ai', 'discordChat.js'), 'utf8'
        );

        const direct = source.split('\n')
            .map((line, index) => ({ line: line.trim(), number: index + 1 }))
            .filter(({ line }) => /\.(reply|send|edit|followUp)\(/.test(line))
            // The three helper definitions are the calls; everything else is a
            // call site that should be going through them.
            .filter(({ line }) => !/^const (reply|send|edit) = \(/.test(line));

        expect(direct.map(entry => `${entry.number}: ${entry.line}`)).toEqual([]);
    });
});
