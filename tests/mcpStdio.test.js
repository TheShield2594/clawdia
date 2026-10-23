'use strict';

// MCP servers the bot runs itself and speaks to over stdin/stdout — the
// transport most servers ship with. These run a real child process (a tiny
// server in tests/helpers/stdioMcpServer.js), because what can go wrong here is
// mostly about processes: starting, dying, being stopped, and what they inherit.

const path = require('path');
const { McpStdioClient } = require('../src/services/ai/mcp/stdio');

const SERVER = path.join(__dirname, 'helpers', 'stdioMcpServer.js');
const stdio = (extra = {}) => ({ command: process.execPath, args: [SERVER], env: {}, ...extra });

const clients = [];
function makeClient(options = {}) {
    const client = new McpStdioClient({ stdio: stdio(options.stdio), label: 'test-stdio', ...options.client });
    clients.push(client);
    return client;
}

afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
});

test('handshakes, lists tools and calls one, past a banner on stdout', async () => {
    const client = makeClient();
    await client.initialize();
    expect(client.serverInfo).toMatchObject({ name: 'test-stdio' });

    const tools = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['echo', 'env', 'crash']);

    const result = await client.callTool('echo', { text: 'hello' });
    expect(result.content[0].text).toBe('echo: hello');
});

test('concurrent calls each get their own answer', async () => {
    const client = makeClient();
    const answers = await Promise.all(['a', 'b', 'c'].map(text => client.callTool('echo', { text })));
    expect(answers.map(answer => answer.content[0].text)).toEqual(['echo: a', 'echo: b', 'echo: c']);
});

test('the process gets what its env names, and none of the bot\'s secrets', async () => {
    const before = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = 'bot-secret';
    try {
        const client = makeClient({ stdio: { env: { VAULT_PATH: '/vault' } } });
        const result = await client.callTool('env', {});
        expect(JSON.parse(result.content[0].text)).toEqual({ secret: null, vault: '/vault', hasPath: true });
    } finally {
        if (before === undefined) delete process.env.DISCORD_TOKEN;
        else process.env.DISCORD_TOKEN = before;
    }
});

test('a server that dies fails the call in flight, and the next call starts it again', async () => {
    const client = makeClient();
    await client.initialize();
    const firstPid = client.child.pid;

    const error = await client.callTool('crash', {}).catch(err => err);
    expect(error.message).toMatch(/stopped: exited with code 3/);
    expect(error.message).toMatch(/crashing on purpose/);
    expect(error.sessionExpired).toBe(true);
    expect(client.initialized).toBe(false);

    // Not within the first five seconds of a start, so not a start failure:
    // the next call handshakes a fresh process.
    client.failedAt = 0;
    await client.initialize();
    expect(client.child.pid).not.toBe(firstPid);
    await expect(client.callTool('echo', { text: 'back' })).resolves.toMatchObject({ content: [{ text: 'echo: back' }] });
});

test('a command that does not exist is an error, and is not retried on every message', async () => {
    const client = makeClient({ stdio: { command: '/nonexistent/mcp-server', args: [] } });
    await expect(client.initialize()).rejects.toThrow(/could not start test-stdio/);
    await expect(client.initialize()).rejects.toThrow(/not retrying yet/);
});

test('a server that exits as it starts fails at once, not after the handshake timeout', async () => {
    // A bad argument or a missing package: the process is gone before it has
    // said anything, and the caller must hear so now, not in twenty seconds.
    const client = makeClient({ stdio: { args: ['-e', 'process.stderr.write("bad flag\\n"); process.exit(2)'] } });
    const started = Date.now();
    const error = await client.initialize().catch(err => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/exited with code 2|stopped/);
    expect(Date.now() - started).toBeLessThan(3000);
});

test('a server that dies before the start settles is refused, not handed out dead', async () => {
    // The race the real-process test above cannot force: the exit lands
    // before the start has resolved, and the dead child's stdin still takes a
    // write. Without the check, the request waits out the whole timeout.
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = { write: (_line, cb) => cb(), end: () => {}, on: () => {} };
        child.kill = () => {};
        process.nextTick(() => child.emit('exit', 1, null));
        return child;
    };
    const client = new McpStdioClient({ stdio: stdio(), label: 'test-stdio', spawnImpl });
    clients.push(client);

    const started = Date.now();
    await expect(client.initialize()).rejects.toThrow(/could not start test-stdio: exited with code 1/);
    expect(Date.now() - started).toBeLessThan(3000);
});

test('close stops the process', async () => {
    const client = makeClient();
    await client.initialize();
    const child = client.child;
    const exited = new Promise(resolve => child.once('exit', resolve));
    await client.close();
    await exited;
    expect(client.child).toBeNull();
    expect(client.initialized).toBe(false);
});

test('refuses to be built with nothing to run', () => {
    expect(() => new McpStdioClient({ stdio: { command: '  ' }, label: 'x' })).toThrow(/no command/);
});
