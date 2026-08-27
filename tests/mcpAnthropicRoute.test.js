'use strict';

// Anthropic is the one provider with two ways to reach an MCP server, and the
// difference is not a detail: on their connector the bot never sees the calls,
// so the approval prompt, the tool line in the reply and the activity ledger
// are all absent. A guild that turned approvals on and then picked Claude in a
// dropdown on another tab would have lost them silently, which is the hole the
// `auto` route exists to close.

const mockToolkitFor = jest.fn();
const mockCall = jest.fn();
jest.mock('../src/services/ai/mcp/toolkit', () => ({
    ...jest.requireActual('../src/services/ai/mcp/toolkit'),
    toolkitFor: mockToolkitFor
}));

const mockCreate = jest.fn();
const mockStream = jest.fn();
const mockBetaCreate = jest.fn();
const mockBetaStream = jest.fn();
jest.mock('@anthropic-ai/sdk', () => class {
    constructor() {
        this.messages = { create: mockCreate, stream: mockStream };
        this.beta = { messages: { create: mockBetaCreate, stream: mockBetaStream } };
    }
});

const anthropic = require('../src/services/ai/providers/anthropic');
const { MAX_TOOL_ROUNDS } = require('../src/services/ai/mcp/toolkit');

const GITHUB = { name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true };

const REQ = {
    apiKey: 'sk-ant-test',
    model: 'claude-haiku-4-5',
    systemPrompt: 'You are Clawdia.',
    history: [],
    prompt: 'what changed in the repo?',
    temperature: 0.7,
    maxTokens: 512,
    mcpServers: [GITHUB]
};

const TOOLKIT = {
    definitions: [{
        name: 'github__search_repositories',
        serverName: 'github',
        toolName: 'search_repositories',
        description: 'Search repositories',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        annotations: {},
        confirm: false
    }],
    servers: ['github'],
    call: mockCall
};

const textDelta = text => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const use = (id, input) => ({ type: 'tool_use', id, name: 'github__search_repositories', input });
const usage = (input_tokens, output_tokens) => ({ input_tokens, output_tokens });

// A streamed response: the deltas, then whatever finalMessage() resolves to.
function streamed(events, final) {
    return {
        [Symbol.asyncIterator]: async function* () { for (const event of events) yield event; },
        finalMessage: async () => final
    };
}

const collect = async iterable => {
    const out = [];
    for await (const piece of iterable) out.push(piece);
    return out;
};

beforeEach(() => {
    jest.resetAllMocks();
    mockToolkitFor.mockResolvedValue(TOOLKIT);
    mockCall.mockResolvedValue('clawdia, 3 open PRs');
    // The connector path, for the cases that should take it.
    mockBetaStream.mockReturnValue(streamed([textDelta('hi')], { content: [], stop_reason: 'end_turn' }));
    mockStream.mockReturnValue(streamed([textDelta('hi')], { content: [], stop_reason: 'end_turn' }));
    mockBetaCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' });
});

describe('which route a request takes', () => {
    // The connector route builds no toolkit at all, so whether toolkitFor was
    // asked is exactly the question "did this go through the bot's client".
    const tookClientRoute = () => mockToolkitFor.mock.calls.length > 0;

    test('the connector, for a guild that set nothing', async () => {
        await collect(anthropic.stream(REQ));
        expect(tookClientRoute()).toBe(false);
    });

    test('the client, when the guild asked for it outright', async () => {
        await collect(anthropic.stream({ ...REQ, mcpRoute: 'client' }));
        expect(tookClientRoute()).toBe(true);
    });

    test('the client on auto, once approvals are on', async () => {
        // The hole this closes: approvals cannot run on the connector, so
        // leaving this on the connector would turn them off without saying so.
        await collect(anthropic.stream({ ...REQ, mcpConfirm: 'destructive' }));
        expect(tookClientRoute()).toBe(true);
    });

    test('the client on auto, when a connection names tools to confirm', async () => {
        await collect(anthropic.stream({
            ...REQ,
            mcpServers: [{ ...GITHUB, confirmTools: ['create_issue'] }]
        }));
        expect(tookClientRoute()).toBe(true);
    });

    test('the connector on auto when approvals are explicitly off', async () => {
        await collect(anthropic.stream({ ...REQ, mcpConfirm: 'off' }));
        expect(tookClientRoute()).toBe(false);
    });

    test('the connector when the guild insisted, approvals or not', async () => {
        // Their instance, their call — but it is a choice they made rather than
        // one a provider dropdown made for them.
        await collect(anthropic.stream({ ...REQ, mcpRoute: 'connector', mcpConfirm: 'always' }));
        expect(tookClientRoute()).toBe(false);
    });

    test('no route at all for a caller that switched MCP off', async () => {
        // /forge and /questgen parse the reply as JSON.
        await collect(anthropic.stream({ ...REQ, mcpRoute: 'client', useMcp: false }));
        expect(tookClientRoute()).toBe(false);
    });

    test('falls back to the plain path when the client route finds no servers', async () => {
        mockToolkitFor.mockResolvedValue(null);
        const pieces = await collect(anthropic.stream({ ...REQ, mcpRoute: 'client', mcpServers: [] }));
        expect(pieces.join('')).toBe('hi');
    });

    test('complete picks its route the same way', async () => {
        await anthropic.complete({ ...REQ, mcpConfirm: 'writes' });
        expect(tookClientRoute()).toBe(true);
    });
});

describe('the client-side tool loop', () => {
    const CLIENT = { ...REQ, mcpRoute: 'client' };

    test('offers each MCP tool in the shape the Messages API takes', async () => {
        await collect(anthropic.stream(CLIENT));

        expect(mockStream.mock.calls[0][0].tools).toEqual([{
            name: 'github__search_repositories',
            description: 'Search repositories',
            input_schema: TOOLKIT.definitions[0].inputSchema
        }]);
        // Plain tools are generally available; only the connector needs a beta.
        expect(mockBetaStream).not.toHaveBeenCalled();
    });

    test('runs a tool call and asks again with the result', async () => {
        mockStream
            .mockReturnValueOnce(streamed([], {
                content: [use('tu_1', { q: 'clawdia' })],
                usage: usage(100, 20)
            }))
            .mockReturnValueOnce(streamed([textDelta('Three open PRs.')], {
                content: [{ type: 'text', text: 'Three open PRs.' }],
                usage: usage(300, 10)
            }));

        const pieces = await collect(anthropic.stream(CLIENT));

        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
        expect(pieces.join('')).toBe('Three open PRs.');

        const second = mockStream.mock.calls[1][0].messages;
        expect(second.at(-2)).toEqual({ role: 'assistant', content: [use('tu_1', { q: 'clawdia' })] });
        expect(second.at(-1)).toEqual({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'clawdia, 3 open PRs' }]
        });
    });

    test('runs a round\'s calls at the same time, answering each by its own id', async () => {
        mockStream
            .mockReturnValueOnce(streamed([], {
                content: [use('tu_1', { q: 'a' }), use('tu_2', { q: 'b' })]
            }))
            .mockReturnValueOnce(streamed([textDelta('Done.')], { content: [] }));

        let inFlight = 0;
        let peak = 0;
        mockCall.mockImplementation(async (_name, args) => {
            peak = Math.max(peak, ++inFlight);
            await new Promise(resolve => setTimeout(resolve, args.q === 'a' ? 10 : 1));
            inFlight--;
            return `result for ${args.q}`;
        });

        await collect(anthropic.stream(CLIENT));

        expect(peak).toBe(2);
        expect(mockStream.mock.calls[1][0].messages.at(-1).content).toEqual([
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'result for a' },
            { type: 'tool_result', tool_use_id: 'tu_2', content: 'result for b' }
        ]);
    });

    test('puts a blank line between a preamble and the answer after it', async () => {
        // Two separate pieces of prose from two rounds; run together they read
        // as one sentence colliding with another.
        mockStream
            .mockReturnValueOnce(streamed([textDelta('Let me look.')], { content: [use('tu_1', {})] }))
            .mockReturnValueOnce(streamed([textDelta('Three open PRs.')], { content: [] }));

        expect((await collect(anthropic.stream(CLIENT))).join('')).toBe('Let me look.\n\nThree open PRs.');
    });

    test('withholds the tools on the last round so a turn cannot end mid-call', async () => {
        for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
            mockStream.mockReturnValueOnce(streamed([], { content: [use(`tu_${i}`, {})] }));
        }
        mockStream.mockReturnValueOnce(streamed([textDelta('Enough.')], { content: [] }));

        await collect(anthropic.stream(CLIENT));

        expect(mockStream).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
        expect(mockStream.mock.calls[MAX_TOOL_ROUNDS - 1][0]).toHaveProperty('tools');
        expect(mockStream.mock.calls[MAX_TOOL_ROUNDS][0]).not.toHaveProperty('tools');
    });

    test('bills every round of a tool-calling turn, not just the last', async () => {
        mockStream
            .mockReturnValueOnce(streamed([], { content: [use('tu_1', {})], usage: usage(100, 20) }))
            .mockReturnValueOnce(streamed([textDelta('Done.')], { content: [], usage: usage(300, 10) }));

        const usageOut = {};
        await collect(anthropic.stream({ ...CLIENT, usageOut }));
        expect(usageOut.usage).toEqual({ inputTokens: 400, outputTokens: 30 });
    });

    test('sends a tool that arrived with no input as an empty object', async () => {
        mockStream
            .mockReturnValueOnce(streamed([], { content: [use('tu_1', undefined)] }))
            .mockReturnValueOnce(streamed([textDelta('Done.')], { content: [] }));

        await collect(anthropic.stream(CLIENT));
        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', {});
    });
});

/**
 * #795. Anthropic computed its tool list once, before the loop. A tool the model
 * loads mid-turn has to be declared in the round after it, so the list is now
 * rebuilt per round — which is the only change this provider needed.
 */
describe('a tool loaded mid-turn', () => {
    const CLIENT = { ...REQ, mcpRoute: 'client' };
    const LOADED = {
        name: 'github__create_issue',
        serverName: 'github',
        toolName: 'create_issue',
        description: 'Open an issue',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        annotations: {},
        confirm: false
    };
    const loadUse = { type: 'tool_use', id: 'tu_load', name: 'load_tools', input: { names: ['github__create_issue'] } };

    const names = tools => (tools || []).map(t => t.name);

    beforeEach(() => {
        // The real toolkit grows its definitions array in place when the load
        // tool is called; this is that, and nothing else.
        const definitions = [{
            name: 'load_tools',
            serverName: null,
            toolName: 'load_tools',
            description: 'Load tools',
            inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } },
            annotations: { readOnlyHint: true },
            confirm: false
        }];
        mockCall.mockImplementation(async name => {
            if (name === 'load_tools') {
                definitions.push(LOADED);
                return 'Loaded: github__create_issue.';
            }
            return 'ok';
        });
        mockToolkitFor.mockResolvedValue({ definitions, servers: ['github'], deferred: ['github__create_issue'], call: mockCall });
    });

    test('is declared on the round after the load, streamed', async () => {
        mockStream
            .mockReturnValueOnce(streamed([], { content: [loadUse], usage: usage(100, 20) }))
            .mockReturnValueOnce(streamed([textDelta('Done.')], { content: [{ type: 'text', text: 'Done.' }], usage: usage(300, 10) }));

        await collect(anthropic.stream(CLIENT));

        expect(names(mockStream.mock.calls[0][0].tools)).toEqual(['load_tools']);
        expect(names(mockStream.mock.calls[1][0].tools)).toEqual(['load_tools', 'github__create_issue']);
    });

    test('and unstreamed', async () => {
        mockCreate
            .mockResolvedValueOnce({ content: [loadUse] })
            .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Done.' }] });

        await anthropic.complete(CLIENT);

        expect(names(mockCreate.mock.calls[1][0].tools)).toEqual(['load_tools', 'github__create_issue']);
    });
});

describe('the client-side tool loop, unstreamed', () => {
    const CLIENT = { ...REQ, mcpRoute: 'client' };

    test('runs the call and answers from the round after it', async () => {
        mockCreate
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: 'Let me look.' }, use('tu_1', { q: 'clawdia' })],
                usage: usage(100, 20)
            })
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: 'Three open PRs.' }],
                usage: usage(300, 10)
            });

        const result = await anthropic.complete(CLIENT);

        expect(mockCall).toHaveBeenCalledWith('github__search_repositories', { q: 'clawdia' });
        // Same spacing the streamed path produces, so a guild that turns
        // streaming off gets the same reply rather than a run-on one.
        expect(result).toEqual({
            text: 'Let me look.\n\nThree open PRs.',
            usage: { inputTokens: 400, outputTokens: 30 }
        });
    });

    test('reports no usage rather than zeroes when the API sent none', async () => {
        mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Done.' }] });
        expect(await anthropic.complete(CLIENT)).toEqual({ text: 'Done.', usage: null });
    });
});
