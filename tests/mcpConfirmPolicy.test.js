'use strict';

// Which tool calls stop and wait for a person.
//
// The interesting cases are all about a tool that did not say what it does.
// MCP annotations are optional and come from the server, so "is this a write"
// has three answers — yes, no, and it never said — and the modes differ only in
// what they do with the third. Getting that wrong in either direction is a real
// cost: too eager and every read needs a click, too trusting and a tool that
// deletes things runs unattended because its author never filled in a hint.

const { validateAiUpdate } = require('../src/dashboard/routes/api/settings');
const {
    needsConfirmation,
    toolAnnotations,
    CONFIRM_MODES,
    DEFAULT_CONFIRM_MODE,
    resolveMcpServers,
    buildAnthropicMcpParams
} = require('../src/config/mcpServers');

const tool = (name, annotations) => (annotations ? { name, annotations } : { name });

const READ = tool('search', { readOnlyHint: true });
const WRITE = tool('create_issue', { readOnlyHint: false });
const DESTRUCTIVE = tool('delete_file', { readOnlyHint: false, destructiveHint: true });
const SAFE_WRITE = tool('append_row', { readOnlyHint: false, destructiveHint: false });
const UNANNOTATED = tool('do_something');

describe('the default', () => {
    test('is off, so nothing changes for a guild that never set it', () => {
        expect(DEFAULT_CONFIRM_MODE).toBe('off');
        for (const t of [READ, WRITE, DESTRUCTIVE, UNANNOTATED]) {
            expect(needsConfirmation(DEFAULT_CONFIRM_MODE, null, t)).toBe(false);
        }
    });

    test('is one of the modes the schema and the dashboard offer', () => {
        expect(CONFIRM_MODES).toContain(DEFAULT_CONFIRM_MODE);
    });

    test('treats a mode nobody recognises as off rather than as always', () => {
        // A stored value from a newer build, or a hand-edited document: the
        // failure has to be "does not ask", never "asks about everything".
        expect(needsConfirmation('paranoid', null, DESTRUCTIVE)).toBe(false);
    });
});

describe('destructive', () => {
    test('asks about a tool the server marked destructive', () => {
        expect(needsConfirmation('destructive', null, DESTRUCTIVE)).toBe(true);
    });

    test('asks about a write that did not say whether it was destructive', () => {
        // destructiveHint defaults to true once a tool has said it is not
        // read-only, so silence there means yes.
        expect(needsConfirmation('destructive', null, WRITE)).toBe(true);
    });

    test('does not ask about a write that said it is not destructive', () => {
        expect(needsConfirmation('destructive', null, SAFE_WRITE)).toBe(false);
    });

    test('does not ask about a read', () => {
        expect(needsConfirmation('destructive', null, READ)).toBe(false);
    });

    test('believes a tool that annotated nothing', () => {
        expect(needsConfirmation('destructive', null, UNANNOTATED)).toBe(false);
    });
});

describe('writes', () => {
    test('asks about anything not explicitly read-only', () => {
        for (const t of [WRITE, DESTRUCTIVE, SAFE_WRITE, UNANNOTATED]) {
            expect(needsConfirmation('writes', null, t)).toBe(true);
        }
    });

    test('still lets a declared read through', () => {
        expect(needsConfirmation('writes', null, READ)).toBe(false);
    });
});

describe('always', () => {
    test('asks about every call, reads included', () => {
        for (const t of [READ, WRITE, UNANNOTATED]) {
            expect(needsConfirmation('always', null, t)).toBe(true);
        }
    });
});

describe('the per-server list', () => {
    const toolset = { confirm_tools: ['search'] };

    test('asks about a named tool even with the mode off', () => {
        // The one rule here that does not take the server's word for anything.
        expect(needsConfirmation('off', toolset, READ)).toBe(true);
    });

    test('leaves everything it does not name to the mode', () => {
        expect(needsConfirmation('off', toolset, DESTRUCTIVE)).toBe(false);
    });

    test('accepts a bare tool name as well as the tool', () => {
        expect(needsConfirmation('off', toolset, 'search')).toBe(true);
    });
});

describe('reading the annotations', () => {
    test('keeps the four hints and the title', () => {
        expect(toolAnnotations({
            annotations: {
                title: 'Delete a file',
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true
            }
        })).toEqual({
            title: 'Delete a file',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true
        });
    });

    test('drops a hint that is not a boolean instead of coercing it', () => {
        // "true" is a string a server sent, not a promise it made.
        expect(toolAnnotations({ annotations: { readOnlyHint: 'true', destructiveHint: 1 } })).toEqual({});
    });

    test('survives a server that sends nonsense where the annotations go', () => {
        expect(toolAnnotations({ annotations: 'read-only' })).toEqual({});
        expect(toolAnnotations({ annotations: ['read-only'] })).toEqual({});
        expect(toolAnnotations({})).toEqual({});
        expect(toolAnnotations(null)).toEqual({});
    });

    test('caps a title long enough to fill a Discord message', () => {
        const { title } = toolAnnotations({ annotations: { title: 'x'.repeat(500) } });
        expect(title.length).toBe(128);
    });
});

describe('the toolset the Anthropic API is sent', () => {
    const guildServer = {
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        enabled: true,
        blockedTools: ['delete_repository'],
        confirmTools: ['create_issue']
    };

    test('carries confirm_tools everywhere the bot reads it', () => {
        const [resolved] = resolveMcpServers([guildServer]);
        expect(resolved.toolset.confirm_tools).toEqual(['create_issue']);
    });

    test('does not send confirm_tools to an API that would reject it', () => {
        // It is the bot's policy, not the connector's; the Messages API
        // refuses a toolset field it does not know.
        const params = buildAnthropicMcpParams([guildServer]);
        expect(params.tools[0]).not.toHaveProperty('confirm_tools');
        expect(params.tools[0]).toMatchObject({ type: 'mcp_toolset', mcp_server_name: 'github' });
    });
});

describe('what the settings endpoint accepts', () => {
    test('every mode the dashboard offers', () => {
        for (const mode of CONFIRM_MODES) {
            expect(validateAiUpdate({ 'ai.mcpConfirm': mode })).toBeNull();
        }
    });

    test('and refuses a policy nobody chose', () => {
        // Mongoose would refuse it on save; catching it here is what turns that
        // into a message the form can show against the field.
        expect(validateAiUpdate({ 'ai.mcpConfirm': 'sometimes' })).toMatch(/ai\.mcpConfirm must be one of/);
        expect(validateAiUpdate({ 'ai.mcpConfirm': true })).toMatch(/ai\.mcpConfirm/);
    });

    test('reads it out of a whole-ai patch as well as a dotted key', () => {
        expect(validateAiUpdate({ ai: { mcpConfirm: 'writes' } })).toBeNull();
        expect(validateAiUpdate({ ai: { mcpConfirm: 'nope' } })).toMatch(/ai\.mcpConfirm/);
    });

    test('leaves a patch that does not mention it alone', () => {
        expect(validateAiUpdate({ 'ai.temperature': 0.5 })).toBeNull();
        expect(validateAiUpdate({ ai: { temperature: 0.5 } })).toBeNull();
    });

    test('still checks the Ollama URL in the same patch', () => {
        // Both rules read the same keys now, so this is the one that would
        // break if the second check had replaced the first.
        expect(validateAiUpdate({ ai: { mcpConfirm: 'off', ollamaBaseUrl: 'file:///etc/passwd' } }))
            .toMatch(/ollamaBaseUrl/);
    });
});
