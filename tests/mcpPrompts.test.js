'use strict';

// MCP prompts, the half of the protocol most clients have nowhere to put. A
// Discord slash command is a name plus arguments, which is exactly the shape of
// a prompt template, so these cover the translation both ways: what a user
// types becoming arguments, and what the server sends back becoming a
// conversation the provider layer can run.

const mockListPrompts = jest.fn();
const mockGetPrompt = jest.fn();
const mockConstructed = [];

jest.mock('../src/services/ai/mcp/client', () => {
    const actual = jest.requireActual('../src/services/ai/mcp/client');
    return {
        ...actual,
        McpHttpClient: class {
            constructor(options) {
                mockConstructed.push(options);
                this.listPrompts = (...args) => mockListPrompts(...args);
                this.getPrompt = (...args) => mockGetPrompt(...args);
                this.close = async () => {};
            }
        }
    };
});

const {
    listGuildPrompts,
    findPrompt,
    renderPrompt,
    parsePromptArguments,
    missingArguments,
    toConversation
} = require('../src/services/ai/mcp/prompts');
const { resetMcpCache } = require('../src/services/ai/mcp/connections');

const SERVER = { name: 'docs', url: 'https://docs.example.com/mcp', enabled: true };
const OTHER = { name: 'wiki', url: 'https://wiki.example.com/mcp', enabled: true };

const REVIEW = {
    name: 'review',
    description: 'Review a pull request',
    arguments: [
        { name: 'pr', description: 'The PR number', required: true },
        { name: 'focus', description: 'What to look at', required: false }
    ]
};

beforeEach(() => {
    jest.clearAllMocks();
    mockConstructed.length = 0;
    resetMcpCache();
    mockListPrompts.mockResolvedValue([REVIEW]);
    mockGetPrompt.mockResolvedValue({
        description: 'Review a pull request',
        messages: [{ role: 'user', content: { type: 'text', text: 'Review PR 42.' } }]
    });
});

describe('listing', () => {
    test('reports each server with the arguments its prompts take', async () => {
        const listings = await listGuildPrompts([SERVER]);

        expect(listings).toHaveLength(1);
        expect(listings[0].server).toBe('docs');
        expect(listings[0].prompts[0]).toMatchObject({
            name: 'review',
            arguments: [
                { name: 'pr', required: true },
                { name: 'focus', required: false }
            ]
        });
    });

    test('a server that is down is reported, not dropped', async () => {
        mockListPrompts.mockRejectedValue(new Error('HTTP 502'));
        const [listing] = await listGuildPrompts([SERVER]);

        expect(listing).toMatchObject({ server: 'docs', prompts: [], error: 'HTTP 502' });
    });

    test('a server with no prompts capability lists none without failing', async () => {
        // What the client returns for a server whose handshake never mentioned
        // prompts: an empty list rather than an error.
        mockListPrompts.mockResolvedValue([]);
        const [listing] = await listGuildPrompts([SERVER]);
        expect(listing).toMatchObject({ prompts: [], error: null });
    });
});

describe('finding one by name', () => {
    const listings = [
        { server: 'docs', prompts: [{ name: 'review', arguments: [] }] },
        { server: 'wiki', prompts: [{ name: 'review', arguments: [] }, { name: 'summarise', arguments: [] }] }
    ];

    test('takes the qualified name the autocomplete produces', () => {
        expect(findPrompt(listings, 'wiki/review')).toMatchObject({ server: 'wiki' });
    });

    test('takes a bare name when only one server offers it', () => {
        expect(findPrompt(listings, 'summarise')).toMatchObject({ server: 'wiki' });
    });

    test('asks rather than guesses when two servers offer the same name', () => {
        const result = findPrompt(listings, 'review');
        expect(result.error).toContain('More than one server');
        expect(result.error).toContain('docs/review');
    });

    test('says where to look when there is no such prompt', () => {
        expect(findPrompt(listings, 'nope').error).toContain('/ai mcp prompts');
    });
});

describe('arguments typed into one option', () => {
    const spec = REVIEW.arguments;

    test('reads name=value pairs, with values that run to the next name', () => {
        expect(parsePromptArguments('pr=42 focus=the migration path', spec).values)
            .toEqual({ pr: '42', focus: 'the migration path' });
    });

    test('strips quotes rather than requiring them', () => {
        expect(parsePromptArguments('pr="42" focus=\'tests\'', spec).values)
            .toEqual({ pr: '42', focus: 'tests' });
    });

    test('a prompt that takes one argument takes the whole string as it', () => {
        expect(parsePromptArguments('what happened last night', [{ name: 'topic' }]).values)
            .toEqual({ topic: 'what happened last night' });
    });

    test('but still reads a pair when one was written', () => {
        expect(parsePromptArguments('topic=the outage', [{ name: 'topic' }]).values)
            .toEqual({ topic: 'the outage' });
    });

    test('a sentence at a prompt that takes several arguments is an error, not a guess', () => {
        expect(parsePromptArguments('please review the migration', spec).error).toContain('name=value');
    });

    test('text before the first pair has nowhere to go, and says so', () => {
        expect(parsePromptArguments('review this pr=42', spec).error).toContain('nowhere to go');
    });

    test('nothing typed is not an error — the prompt may take nothing', () => {
        expect(parsePromptArguments('', spec)).toEqual({ values: {} });
    });

    test('names the required arguments that are still missing', () => {
        expect(missingArguments(spec, { focus: 'tests' })).toEqual(['pr']);
        expect(missingArguments(spec, { pr: '42' })).toEqual([]);
    });
});

describe('what the server sends back', () => {
    test('one user message becomes the turn, with no history', () => {
        expect(toConversation([{ role: 'user', content: { type: 'text', text: 'Hello.' } }]))
            .toEqual({ history: [], prompt: 'Hello.' });
    });

    test('everything before the last user message becomes history', () => {
        const conversation = toConversation([
            { role: 'user', content: [{ type: 'text', text: 'Here is the diff.' }] },
            { role: 'assistant', content: { type: 'text', text: 'Noted.' } },
            { role: 'user', content: { type: 'text', text: 'Now review it.' } }
        ]);

        expect(conversation.history).toEqual([
            { role: 'user', content: 'Here is the diff.' },
            { role: 'assistant', content: 'Noted.' }
        ]);
        expect(conversation.prompt).toBe('Now review it.');
    });

    test('a prompt that ends on the assistant is context to continue from', () => {
        const conversation = toConversation([
            { role: 'user', content: { type: 'text', text: 'Summarise.' } },
            { role: 'assistant', content: { type: 'text', text: 'Here goes:' } }
        ]);

        expect(conversation.history).toHaveLength(2);
        expect(conversation.prompt).toMatch(/continue/i);
    });

    test('an embedded resource is the prompt carrying its own context', () => {
        const conversation = toConversation([{
            role: 'user',
            content: [
                { type: 'resource', resource: { uri: 'file://a.js', text: 'const x = 1;' } },
                { type: 'text', text: 'Review this.' }
            ]
        }]);

        expect(conversation.prompt).toBe('const x = 1;\nReview this.');
    });

    test('content the bot cannot render is named rather than dropped silently', () => {
        const conversation = toConversation([{
            role: 'user',
            content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'What is this?' }]
        }]);

        expect(conversation.prompt).toBe('[image content omitted]\nWhat is this?');
    });

    test('an empty prompt is nothing to run', () => {
        expect(toConversation([])).toBeNull();
    });
});

describe('rendering one prompt', () => {
    test('forwards the arguments untouched and returns a conversation', async () => {
        // Untouched on purpose: turning them into the strings the wire format
        // wants is the client's job, and tests/mcpClient covers it there.
        const rendered = await renderPrompt([SERVER], 'docs', 'review', { pr: 42 });

        expect(mockGetPrompt).toHaveBeenCalledWith('review', { pr: 42 });
        expect(rendered).toMatchObject({ prompt: 'Review PR 42.', history: [] });
    });

    test('a server that refuses the prompt is reported to whoever ran it', async () => {
        mockGetPrompt.mockRejectedValue(new Error('unknown prompt'));
        const rendered = await renderPrompt([SERVER], 'docs', 'review', {});

        expect(rendered.error).toContain('unknown prompt');
    });

    test('a prompt with no usable content is not run as an empty message', async () => {
        mockGetPrompt.mockResolvedValue({ messages: [] });
        expect((await renderPrompt([SERVER], 'docs', 'review', {})).error).toContain('came back empty');
    });

    test('a connection that is not configured is a caller error, not a server one', async () => {
        expect((await renderPrompt([SERVER], 'nope', 'review', {})).error).toContain('No MCP connection');
        expect(mockGetPrompt).not.toHaveBeenCalled();
    });

    test('two servers are listed at once rather than one after the other', async () => {
        await listGuildPrompts([SERVER, OTHER]);
        expect(mockConstructed.map(c => c.label).sort()).toEqual(['docs', 'wiki']);
    });
});
