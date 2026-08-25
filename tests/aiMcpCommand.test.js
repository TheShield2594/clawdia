'use strict';

// `/ai mcp` — the same answers the dashboard gives, for an admin who is already
// in the channel and does not want to open a browser to find out why the bot
// said it could not check something.
//
// The load-bearing parts are the permission gate, and that nothing an MCP
// server chose to call itself reaches a Discord message as markup or a mention:
// tool names, tool titles and error text all come from the far side.

const mockInspectServer = jest.fn();
jest.mock('../src/services/ai/mcp/inspect', () => ({
    inspectServer: (...args) => mockInspectServer(...args)
}));

const mockGetToolUsage = jest.fn(async () => []);
jest.mock('../src/services/ai/mcp/usage', () => ({
    getToolUsage: (...args) => mockGetToolUsage(...args)
}));

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({
    findOne: jest.fn(async () => ({ pinnedMemories: [] })),
    create: jest.fn(async () => ({ pinnedMemories: [] }))
}));

const Guild = require('../src/models/Guild');
const command = require('../src/commands/ai/ai');

const MANAGE_GUILD = 1n << 5n;

function interaction({ sub, group = 'mcp', server, manageGuild = true, focused = null } = {}) {
    const replies = [];
    return {
        replies,
        guild: { id: 'g1' },
        user: { id: 'u1' },
        memberPermissions: { has: flag => manageGuild && flag === MANAGE_GUILD },
        options: {
            getSubcommandGroup: () => group,
            getSubcommand: () => sub,
            getString: () => server,
            getInteger: () => null,
            getFocused: () => focused
        },
        reply: jest.fn(async payload => { replies.push(payload); }),
        deferReply: jest.fn(async () => {}),
        editReply: jest.fn(async payload => { replies.push(payload); }),
        respond: jest.fn(async () => {})
    };
}

const settings = ai => ({ lean: async () => ({ guildId: 'g1', ai }) });

const CONNECTION = {
    name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    enabled: true,
    allowedTools: [],
    blockedTools: ['delete_file'],
    confirmTools: []
};

const OK = {
    success: true,
    message: 'Connected to GitHub MCP Server — 2 tools offered, 1 enabled by your filters.',
    toolCount: 2,
    enabledCount: 1,
    confirmCount: 0,
    tools: [
        { name: 'search_repositories', enabled: true, confirm: false, annotations: { readOnlyHint: true } },
        { name: 'delete_file', enabled: false, confirm: true, annotations: { readOnlyHint: false, destructiveHint: true } }
    ]
};

// Everything the embeds render, flattened, so a test can ask what a channel
// would actually see.
const rendered = payload => {
    const embed = payload.embeds?.[0]?.data;
    if (!embed) return payload.content || '';
    return [
        embed.title,
        embed.description,
        ...(embed.fields || []).flatMap(f => [f.name, f.value]),
        embed.footer?.text
    ].filter(Boolean).join('\n');
};

beforeEach(() => {
    jest.clearAllMocks();
    require('../src/models/User').findOne.mockResolvedValue({ pinnedMemories: [] });
    Guild.findOne.mockReturnValue(settings({ provider: 'openai', mcpServers: [CONNECTION] }));
    mockInspectServer.mockResolvedValue(OK);
    mockGetToolUsage.mockResolvedValue([]);
});

describe('who may run it', () => {
    test('nobody without Manage Server', async () => {
        // Connections carry credentials and reach outside the server; reading
        // them is for the people who could have configured them.
        const i = interaction({ sub: 'servers', manageGuild: false });
        await command.execute(i);

        expect(rendered(i.replies[0])).toMatch(/Manage Server/);
        expect(Guild.findOne).not.toHaveBeenCalled();
    });

    test('and the gate does not touch /ai memories', async () => {
        const i = interaction({ sub: 'memories', group: null, manageGuild: false });
        await command.execute(i);
        expect(i.replies[0]?.content).not.toMatch(/Manage Server/);
    });

    test('every answer is ephemeral', async () => {
        const i = interaction({ sub: 'servers' });
        await command.execute(i);
        expect(i.replies[0].flags).toBeDefined();
    });
});

describe('servers', () => {
    test('lists the connections and what the filters do to them', async () => {
        const i = interaction({ sub: 'servers' });
        await command.execute(i);

        const text = rendered(i.replies[0]);
        expect(text).toContain('github');
        expect(text).toContain('1 blocked');
    });

    test('says what the approval setting means rather than naming it', async () => {
        Guild.findOne.mockReturnValue(settings({ provider: 'openai', mcpConfirm: 'writes', mcpServers: [CONNECTION] }));
        const i = interaction({ sub: 'servers' });
        await command.execute(i);

        expect(rendered(i.replies[0])).toMatch(/not marked read-only needs approval/);
    });

    test('resolves the Claude route, since auto is a question', async () => {
        Guild.findOne.mockReturnValue(settings({
            provider: 'anthropic', mcpConfirm: 'destructive', mcpServers: [CONNECTION]
        }));
        const i = interaction({ sub: 'servers' });
        await command.execute(i);

        expect(rendered(i.replies[0])).toContain('auto → client');
    });

    test('leaves the route out for a provider that only has one', async () => {
        const i = interaction({ sub: 'servers' });
        await command.execute(i);
        expect(rendered(i.replies[0])).not.toContain('Route:');
    });

    test('warns when the selected provider cannot use MCP at all', async () => {
        Guild.findOne.mockReturnValue(settings({ provider: 'nope', mcpServers: [CONNECTION] }));
        const i = interaction({ sub: 'servers' });
        await command.execute(i);

        expect(rendered(i.replies[0])).toMatch(/cannot use MCP/);
    });

    test('says where to add one when there are none', async () => {
        Guild.findOne.mockReturnValue(settings({ provider: 'openai', mcpServers: [] }));
        const i = interaction({ sub: 'servers' });
        await command.execute(i);

        expect(rendered(i.replies[0])).toMatch(/dashboard/i);
    });
});

describe('tools and test', () => {
    test('names each tool and what happens to it', async () => {
        const i = interaction({ sub: 'tools', server: 'github' });
        await command.execute(i);

        const text = rendered(i.replies[0]);
        expect(text).toContain('search_repositories');
        expect(text).toContain('read-only');
        expect(text).toContain('blocked');
    });

    test('defers first, because a handshake does not fit in three seconds', async () => {
        const i = interaction({ sub: 'tools', server: 'github' });
        await command.execute(i);
        expect(i.deferReply).toHaveBeenCalled();
    });

    test('asks the inspector with the guild\'s own approval policy', async () => {
        Guild.findOne.mockReturnValue(settings({ provider: 'openai', mcpConfirm: 'always', mcpServers: [CONNECTION] }));
        const i = interaction({ sub: 'test', server: 'github' });
        await command.execute(i);

        expect(mockInspectServer).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'github' }),
            { confirmMode: 'always' }
        );
    });

    test('reports a failed connection as the answer, not as an error', async () => {
        mockInspectServer.mockResolvedValue({
            success: false, message: 'HTTP 401 — the server rejected the authorization token',
            toolCount: 0, enabledCount: 0, confirmCount: 0, tools: []
        });
        const i = interaction({ sub: 'test', server: 'github' });
        await command.execute(i);

        expect(rendered(i.replies[0])).toMatch(/401/);
    });

    test('answers a name that is not configured without dialling anything', async () => {
        const i = interaction({ sub: 'tools', server: 'nope' });
        await command.execute(i);

        expect(rendered(i.replies[0])).toMatch(/No MCP connection named/);
        expect(mockInspectServer).not.toHaveBeenCalled();
        expect(i.deferReply).not.toHaveBeenCalled();
    });
});

describe('activity', () => {
    test('shows the rollup the dashboard shows', async () => {
        mockGetToolUsage.mockResolvedValue([{
            server: 'github', calls: 12, failures: 1, declined: 2, avgMs: 1200, unreachable: 0,
            lastError: null, tools: [{ tool: 'search_repositories', calls: 12, failures: 1, avgMs: 1200 }]
        }]);

        const i = interaction({ sub: 'activity' });
        await command.execute(i);

        const text = rendered(i.replies[0]);
        expect(text).toContain('12 calls');
        expect(text).toContain('2 not approved');
        expect(text).toContain('search_repositories');
    });

    test('says so plainly when nothing has run', async () => {
        const i = interaction({ sub: 'activity' });
        await command.execute(i);
        expect(rendered(i.replies[0])).toMatch(/No tool calls yet/);
    });
});

describe('names from the far side', () => {
    test('a tool name cannot open markup or ping a role', async () => {
        mockInspectServer.mockResolvedValue({
            ...OK,
            tools: [{ name: '@everyone <@&1> `x`', enabled: true, confirm: false, annotations: {} }]
        });
        const i = interaction({ sub: 'tools', server: 'github' });
        await command.execute(i);

        const text = rendered(i.replies[0]);
        expect(text).not.toContain('@everyone');
        expect(text).not.toContain('<@&1>');
    });

    test('nor can the text of whatever error it returned', async () => {
        mockInspectServer.mockResolvedValue({
            success: false, message: 'refused by @everyone',
            toolCount: 0, enabledCount: 0, confirmCount: 0, tools: []
        });
        const i = interaction({ sub: 'tools', server: 'github' });
        await command.execute(i);

        expect(rendered(i.replies[0])).not.toContain('@everyone');
    });
});

describe('autocomplete', () => {
    test('offers the configured names without dialling anything', async () => {
        const i = interaction({ sub: 'tools', focused: 'git' });
        await command.autocomplete(i);

        expect(i.respond).toHaveBeenCalledWith([{ name: 'github', value: 'github' }]);
        expect(mockInspectServer).not.toHaveBeenCalled();
    });

    test('filters by what has been typed so far', async () => {
        const i = interaction({ sub: 'tools', focused: 'zzz' });
        await command.autocomplete(i);
        expect(i.respond).toHaveBeenCalledWith([]);
    });
});
