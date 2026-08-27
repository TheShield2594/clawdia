'use strict';

/**
 * #795. `MAX_TOOLS` is 64 and every enabled tool's name, description and JSON
 * Schema travels on *every* message to the provider. On a guild with GitHub's
 * server connected — around ninety tools published — that is the dominant token
 * cost of the whole feature, on a bot whose default reply budget is 1024.
 *
 * So the schemas past a threshold are withheld, and in their place goes one
 * meta-tool whose parameter carries a catalogue: a name and one line each. The
 * model asks for what it wants by name, and the *next* round declares them for
 * real — which is the part that makes this bigger than it looks, because a
 * provider that computed its tool list once before the loop would never declare
 * the tool the model just asked for.
 */

const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockConstructed = [];

jest.mock('../src/services/ai/mcp/client', () => ({
    McpError: class extends Error {},
    McpHttpClient: class {
        constructor(options) {
            mockConstructed.push(options);
            this.listTools = mockListTools;
            this.callTool = mockCallTool;
            this.close = jest.fn(async () => {});
        }
    }
}));

const {
    prepareMcpToolkit, resetMcpCache, DEFERRED_AFTER, LOAD_TOOL_NAME, MAX_TOOLS,
} = require('../src/services/ai/mcp/toolkit');

const SERVER = {
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    authorizationToken: 'ghp_x',
    enabled: true,
    allowedTools: [],
    blockedTools: [],
};

/** `count` tools with real schemas, so a withheld one is measurably cheaper. */
function manyTools(count) {
    return Array.from({ length: count }, (_, i) => ({
        name: `tool_${i}`,
        description: `Does thing number ${i}`,
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    }));
}

function textResult(text) {
    return { content: [{ type: 'text', text }], structuredContent: null, isError: false };
}

const loadTool = toolkit => toolkit.definitions.find(d => d.name === LOAD_TOOL_NAME);
const declared = toolkit => toolkit.definitions.filter(d => d.name !== LOAD_TOOL_NAME).map(d => d.name);

beforeEach(() => {
    jest.clearAllMocks();
    mockConstructed.length = 0;
    resetMcpCache();
    mockCallTool.mockResolvedValue(textResult('ok'));
});

describe('a guild small enough not to need this', () => {
    test('declares everything and offers no meta-tool at all', async () => {
        mockListTools.mockResolvedValue(manyTools(DEFERRED_AFTER));
        const toolkit = await prepareMcpToolkit([SERVER]);

        expect(toolkit.definitions).toHaveLength(DEFERRED_AFTER);
        expect(loadTool(toolkit)).toBeUndefined();
        expect(toolkit.deferred).toEqual([]);
    });
});

describe('a guild with more tools than fit', () => {
    let toolkit;

    beforeEach(async () => {
        mockListTools.mockResolvedValue(manyTools(DEFERRED_AFTER + 10));
        toolkit = await prepareMcpToolkit([SERVER]);
    });

    test('ships the first tools\' schemas and withholds the rest', () => {
        expect(declared(toolkit)).toHaveLength(DEFERRED_AFTER);
        expect(toolkit.deferred).toHaveLength(10);
        expect(toolkit.deferred[0]).toBe(`github__tool_${DEFERRED_AFTER}`);
    });

    test('offers exactly one meta-tool alongside them', () => {
        expect(toolkit.definitions.filter(d => d.name === LOAD_TOOL_NAME)).toHaveLength(1);
    });

    // The catalogue is in the parameter, not in the tool's own description:
    // descriptions are truncated to 1024 characters on the way out and forty
    // catalogue lines do not fit. The enum is also what stops the model asking
    // for a tool that does not exist.
    test('carries the catalogue in the parameter, where it is not truncated', () => {
        const { description, inputSchema } = loadTool(toolkit);

        expect(description.length).toBeLessThanOrEqual(1024);
        expect(inputSchema.properties.names.items.enum).toEqual(toolkit.deferred);
        expect(inputSchema.properties.names.description)
            .toContain(`- github__tool_${DEFERRED_AFTER}: Does thing number ${DEFERRED_AFTER}`);
    });

    // The whole point: a catalogue line has to be a fraction of a schema, or
    // the deferral has bought nothing.
    test('a catalogue line costs a fraction of what the schema it replaces would', () => {
        const catalogue = loadTool(toolkit).inputSchema.properties.names.description.length;
        const schemas = JSON.stringify(
            toolkit.deferred.map(name => ({ name, description: 'Does thing number N', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } })),
        ).length;

        expect(catalogue).toBeLessThan(schemas / 2);
    });

    test('the tools it withheld are not declared to the model', () => {
        expect(declared(toolkit)).not.toContain(`github__tool_${DEFERRED_AFTER}`);
    });
});

describe('loading a tool', () => {
    let toolkit;
    const wanted = () => `github__tool_${DEFERRED_AFTER}`;

    beforeEach(async () => {
        mockListTools.mockResolvedValue(manyTools(DEFERRED_AFTER + 10));
        toolkit = await prepareMcpToolkit([SERVER]);
    });

    // Mutated in place rather than replaced, so a provider holding the array
    // sees the new tool. Every provider still has to rebuild its own tool
    // parameters inside the round loop — that is what the provider-loop tests
    // pin.
    test('declares it from the next round on', async () => {
        const before = toolkit.definitions.length;
        await toolkit.call(LOAD_TOOL_NAME, { names: [wanted()] });

        expect(toolkit.definitions).toHaveLength(before + 1);
        expect(declared(toolkit)).toContain(wanted());
    });

    test('says it cannot be called until the next turn', async () => {
        const reply = await toolkit.call(LOAD_TOOL_NAME, { names: [wanted()] });

        expect(reply).toContain('Loaded: ');
        expect(reply).toContain(wanted());
        expect(reply).toMatch(/next turn/i);
    });

    test('runs nothing against the server', async () => {
        await toolkit.call(LOAD_TOOL_NAME, { names: [wanted()] });
        expect(mockCallTool).not.toHaveBeenCalled();
    });

    test('loads several at once', async () => {
        const names = [wanted(), `github__tool_${DEFERRED_AFTER + 1}`];
        await toolkit.call(LOAD_TOOL_NAME, { names });

        expect(declared(toolkit)).toEqual(expect.arrayContaining(names));
    });

    // Everything is answered in words, because an exception here costs the model
    // a whole round over a typo.
    test('a name it invented comes back as a message, not a failure', async () => {
        const reply = await toolkit.call(LOAD_TOOL_NAME, { names: ['github__not_a_tool'] });

        expect(reply).toContain('No such tool');
        expect(declared(toolkit)).toHaveLength(DEFERRED_AFTER);
    });

    test('a tool it can already see is answered with "just call it"', async () => {
        const reply = await toolkit.call(LOAD_TOOL_NAME, { names: ['github__tool_0'] });

        expect(reply).toContain('Already available');
        expect(reply).not.toContain('No such tool');
    });

    test('loading the same tool twice does not declare it twice', async () => {
        await toolkit.call(LOAD_TOOL_NAME, { names: [wanted()] });
        const after = toolkit.definitions.length;
        const reply = await toolkit.call(LOAD_TOOL_NAME, { names: [wanted()] });

        expect(toolkit.definitions).toHaveLength(after);
        expect(reply).toContain('Already available');
    });

    test('an empty list asks again rather than reporting success', async () => {
        const reply = await toolkit.call(LOAD_TOOL_NAME, { names: [] });

        expect(reply).toContain('No tool names were given');
    });

    test('a missing argument is not a crash', async () => {
        await expect(toolkit.call(LOAD_TOOL_NAME, {})).resolves.toContain('No tool names were given');
        await expect(toolkit.call(LOAD_TOOL_NAME, undefined)).resolves.toContain('No tool names were given');
    });

    // The model named a real tool. Refusing would spend a round on bookkeeping;
    // running it and declaring the schema from here on is strictly better.
    test('a deferred tool called before loading runs anyway, and is declared after', async () => {
        const reply = await toolkit.call(wanted(), { q: 'x' });

        expect(mockCallTool).toHaveBeenCalledWith(`tool_${DEFERRED_AFTER}`, { q: 'x' }, expect.anything());
        expect(reply).toContain('ok');
        expect(declared(toolkit)).toContain(wanted());
    });

    test('a name that is neither declared nor catalogued is still refused', async () => {
        await expect(toolkit.call('github__nope', {})).resolves.toContain('No tool named');
        expect(mockCallTool).not.toHaveBeenCalled();
    });
});

describe('what the operator asked for', () => {
    // `defer_loading: false` is how a guild says "this is the one I actually
    // use" — it has to survive being the fortieth tool in the list.
    test('an explicitly eager tool is declared however many others there are', async () => {
        mockListTools.mockResolvedValue(manyTools(DEFERRED_AFTER + 5));
        const toolkit = await prepareMcpToolkit([{
            ...SERVER,
            configs: { [`tool_${DEFERRED_AFTER + 4}`]: { enabled: true, defer_loading: false } },
        }]);

        expect(declared(toolkit)).toContain(`github__tool_${DEFERRED_AFTER + 4}`);
        expect(toolkit.deferred).not.toContain(`github__tool_${DEFERRED_AFTER + 4}`);
    });

    test('an explicitly deferred tool is withheld on a server with three', async () => {
        mockListTools.mockResolvedValue(manyTools(3));
        const toolkit = await prepareMcpToolkit([{
            ...SERVER,
            configs: { tool_1: { enabled: true, defer_loading: true } },
        }]);

        expect(toolkit.deferred).toEqual(['github__tool_1']);
        expect(declared(toolkit)).toEqual(['github__tool_0', 'github__tool_2']);
    });

    test('a server-wide default defers everything but the meta-tool', async () => {
        mockListTools.mockResolvedValue(manyTools(3));
        const toolkit = await prepareMcpToolkit([{
            ...SERVER,
            defaultConfig: { enabled: true, defer_loading: true },
        }]);

        expect(declared(toolkit)).toEqual([]);
        expect(loadTool(toolkit)).toBeDefined();
        expect(toolkit.deferred).toHaveLength(3);
    });

    // A blocked tool is off, not withheld: the catalogue must not advertise
    // something the guild has forbidden.
    test('a blocked tool is not catalogued either', async () => {
        mockListTools.mockResolvedValue(manyTools(DEFERRED_AFTER + 3));
        const toolkit = await prepareMcpToolkit([{
            ...SERVER,
            blockedTools: [`tool_${DEFERRED_AFTER + 1}`],
        }]);

        expect(toolkit.deferred).not.toContain(`github__tool_${DEFERRED_AFTER + 1}`);
        expect(declared(toolkit)).not.toContain(`github__tool_${DEFERRED_AFTER + 1}`);
    });
});

describe('the ceiling', () => {
    // A catalogue line is cheap but not free, and the model still has to read
    // it — so the cap counts what is offered, declared or not.
    test('counts catalogued tools against MAX_TOOLS', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockListTools.mockResolvedValue(manyTools(MAX_TOOLS + 20));

        const toolkit = await prepareMcpToolkit([SERVER]);

        expect(declared(toolkit).length + toolkit.deferred.length).toBe(MAX_TOOLS);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`more than ${MAX_TOOLS} tools`));
        warn.mockRestore();
    });

    test('still returns null when there is nothing to offer at all', async () => {
        mockListTools.mockResolvedValue([]);
        expect(await prepareMcpToolkit([SERVER])).toBeNull();
    });
});
