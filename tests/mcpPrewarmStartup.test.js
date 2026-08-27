'use strict';

// The first message after a restart used to pay full MCP discovery — a
// handshake and a tools/list per server — while the user watched an ellipsis.
// Nothing about that work depends on what the message says, so it is done at
// startup instead. What matters here is that it stays best-effort in every
// direction: a database that is not up, a server that is down and a shard that
// does not own the guild all cost a warm cache and nothing else.

jest.mock('../src/models/Guild', () => ({ find: jest.fn() }));
jest.mock('../src/services/ai/mcp/toolkit', () => ({ prewarmMcpServers: jest.fn(async () => 1) }));
jest.mock('../src/config/mcpServers', () => ({ getMcpServers: jest.fn(() => []) }));

const Guild = require('../src/models/Guild');
const { getMcpServers } = require('../src/config/mcpServers');
const { prewarmMcpServers } = require('../src/services/ai/mcp/toolkit');
const { warmNow, startMcpPrewarm, MAX_GUILDS } = require('../src/services/ai/mcp/prewarm');

const GITHUB = { name: 'github', url: 'https://api.githubcopilot.com/mcp/', enabled: true };

// A shard's guild cache holds exactly the guilds Discord routes to it.
const clientWith = (...guildIds) => ({ guilds: { cache: new Map(guildIds.map(id => [id, {}])) } });

function stored(guilds) {
    Guild.find.mockReturnValue({ lean: async () => guilds });
}

beforeEach(() => {
    jest.clearAllMocks();
    prewarmMcpServers.mockResolvedValue(1);
    getMcpServers.mockReturnValue([]);
});

describe('which guilds are warmed', () => {
    test('only the ones with MCP configured, and only on the shard that serves them', async () => {
        stored([
            { guildId: 'mine', ai: { mcpServers: [GITHUB] } },
            { guildId: 'another-shard', ai: { mcpServers: [GITHUB] } }
        ]);

        expect(await warmNow(clientWith('mine'))).toBe(1);
        expect(prewarmMcpServers).toHaveBeenCalledTimes(1);
        expect(prewarmMcpServers).toHaveBeenCalledWith([GITHUB]);
    });

    test('the query asks for the two things that make a guild worth warming', async () => {
        stored([]);
        await warmNow(clientWith());

        expect(Guild.find).toHaveBeenCalledWith(
            { 'ai.enabled': true, 'ai.mcpServers.0': { $exists: true } },
            expect.any(Object)
        );
    });

    test('a guild with none of its own is still warmed when the operator has some', async () => {
        // Config-file servers belong to every AI-enabled guild, so "has no
        // servers of its own" is not the same as "has no servers".
        getMcpServers.mockReturnValue([{ name: 'wiki' }]);
        stored([{ guildId: 'mine', ai: {} }]);

        await warmNow(clientWith('mine'));

        expect(Guild.find).toHaveBeenCalledWith({ 'ai.enabled': true }, expect.any(Object));
        expect(prewarmMcpServers).toHaveBeenCalledWith([]);
    });

    test('an unreadable config file is not a reason to warm nothing', async () => {
        getMcpServers.mockImplementation(() => { throw new Error('bad JSON'); });
        stored([{ guildId: 'mine', ai: { mcpServers: [GITHUB] } }]);

        expect(await warmNow(clientWith('mine'))).toBe(1);
    });

    test('a deployment with MCP everywhere does not open every connection at once', async () => {
        stored(Array.from({ length: MAX_GUILDS + 20 }, (_, n) => ({
            guildId: `g${n}`,
            ai: { mcpServers: [GITHUB] }
        })));

        const client = { guilds: { cache: { has: () => true } } };
        await warmNow(client);
        expect(prewarmMcpServers).toHaveBeenCalledTimes(MAX_GUILDS);
    });

    test('nothing configured anywhere is nothing to do', async () => {
        stored([]);
        expect(await warmNow(clientWith('mine'))).toBe(0);
        expect(prewarmMcpServers).not.toHaveBeenCalled();
    });
});

describe('when it cannot run', () => {
    test('a database that is not up costs a warm cache and nothing else', async () => {
        Guild.find.mockReturnValue({ lean: async () => { throw new Error('no primary'); } });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(warmNow(clientWith('mine'))).resolves.toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no primary'));
        warn.mockRestore();
    });

    test('the starter never rejects into the scheduler', async () => {
        jest.useFakeTimers();
        Guild.find.mockImplementation(() => { throw new Error('boom'); });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => startMcpPrewarm(clientWith('mine'))).not.toThrow();
        jest.runOnlyPendingTimers();
        await Promise.resolve();

        warn.mockRestore();
        jest.useRealTimers();
    });

    test('it does not hold the process open', () => {
        jest.useFakeTimers();
        const timer = startMcpPrewarm(clientWith());
        expect(timer.hasRef()).toBe(false);
        jest.useRealTimers();
    });
});
