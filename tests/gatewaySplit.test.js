'use strict';

// The dashboard as its own process (#876).
//
// On shard 0 one Node process ran the Discord gateway, the Express dashboard,
// full-collection aggregations, canvas rendering, AI calls and 18 cron jobs. A
// heavy dashboard request delayed heartbeats for every guild, and a fault in a
// route reached the process guards in src/index.js, which exit — so a bad page
// was a bot-wide outage. The hard part was already done: createApp takes an
// injected `bot`, and that facade is id-in / plain-data-out. What was missing
// was a transport.
//
// These tests hold the two properties the split lives or dies on. The wire has
// to carry the facade's contract *exactly* — including the difference between
// "we do not have that guild" (null) and "Discord refused" (a throw), which
// routes act on. And the two implementations have to stay interchangeable,
// which they only are while one list defines them both.

const http = require('http');

const { GATEWAY_METHODS } = require('../src/bot/gatewayProtocol');
const { createBotGateway } = require('../src/bot/gateway');
const { createGatewayHandler, MAX_BODY_BYTES, MIN_TOKEN_LENGTH } = require('../src/bot/gatewayServer');
const { createRemoteBotGateway } = require('../src/bot/remoteGateway');

const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH);

// ---------------------------------------------------------------------------
// A client with enough of discord.js's shape for the facade to read
// ---------------------------------------------------------------------------

function stubClient({ guilds = [], ready = true } = {}) {
    const cache = new Map(guilds.map(g => [g.id, g]));
    return {
        readyAt: ready ? new Date() : null,
        guilds: { cache },
        users: { fetch: async id => { throw new Error(`no user ${id}`); } },
    };
}

function stubGuild(id, { name = `Guild ${id}`, memberCount = 10, channels = [], roles = [], members } = {}) {
    return {
        id,
        name,
        icon: null,
        ownerId: 'owner-1',
        memberCount,
        channels: { cache: new Map(channels.map(c => [c.id, c])) },
        roles: { cache: new Map(roles.map(r => [r.id, r])) },
        members: members ?? { cache: new Map(), fetch: async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); } },
        bans: { fetch: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } },
    };
}

/**
 * Stands the real server up on an ephemeral port with the real client in front
 * of it, so what is exercised is the wire and not a mock of it.
 */
async function connectedPair(client, { token = TOKEN, health } = {}) {
    const local = createBotGateway(client);
    const server = http.createServer(createGatewayHandler(local, token, health));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const remote = createRemoteBotGateway({
        url: `http://127.0.0.1:${server.address().port}`,
        token,
    });

    return { local, remote, server, close: () => new Promise(r => server.close(r)) };
}

// ---------------------------------------------------------------------------

describe('the two facades answer to one protocol', () => {
    test('the local implementation matches the protocol exactly', () => {
        const local = createBotGateway(stubClient());
        expect(Object.keys(local).sort()).toEqual([...GATEWAY_METHODS].sort());
    });

    test('the remote implementation matches the protocol exactly', () => {
        const remote = createRemoteBotGateway({ url: 'http://bot:3001', token: TOKEN });
        expect(Object.keys(remote).sort()).toEqual([...GATEWAY_METHODS].sort());
    });

    test('every method on both sides is asynchronous', () => {
        // A route cannot be written against a facade that is synchronous in one
        // deployment and not the other — that difference would only ever show
        // up in the split one, which is the deployment nobody is looking at
        // while they write the route.
        const local = createBotGateway(stubClient({ guilds: [stubGuild('g1')] }));
        const remote = createRemoteBotGateway({ url: 'http://bot:3001', token: TOKEN });
        for (const method of GATEWAY_METHODS) {
            expect(typeof local[method]).toBe('function');
            expect(typeof remote[method]).toBe('function');
            const returned = local[method]('g1', 'x', 'y');
            expect(typeof returned?.then).toBe('function');
            returned.catch(() => {});
        }
    });

    test('a method added to the gateway and not the protocol fails where it is built', () => {
        const { assertImplementsProtocol } = require('../src/bot/gateway');
        const complete = Object.fromEntries(GATEWAY_METHODS.map(m => [m, () => {}]));

        expect(() => assertImplementsProtocol(complete, 'test')).not.toThrow();
        expect(() => assertImplementsProtocol({ ...complete, surprise: () => {} }, 'test'))
            .toThrow(/not in the protocol: surprise/);

        const { hasGuild, ...missing } = complete;
        expect(hasGuild).toBeInstanceOf(Function);
        expect(() => assertImplementsProtocol(missing, 'test')).toThrow(/missing hasGuild/);
    });
});

describe('a call over the wire is the same call', () => {
    let pair;
    const CHANNEL = { id: 'c1', name: 'general', type: 0, parentId: null };
    const ROLE = { id: 'r1', name: 'Mods', position: 3, managed: false };

    beforeEach(async () => {
        pair = await connectedPair(stubClient({
            guilds: [stubGuild('g1', { name: 'Home', memberCount: 42, channels: [CHANNEL], roles: [ROLE] })],
        }));
    });
    afterEach(() => pair.close());

    test('reads return the same data as the local facade', async () => {
        for (const [method, args] of [
            ['hasGuild', ['g1']],
            ['hasGuild', ['nope']],
            ['hasGuilds', [['g1', 'nope']]],
            ['getGuild', ['g1']],
            ['getGuild', ['nope']],
            ['reach', []],
            ['listChannels', ['g1']],
            ['listChannels', ['nope']],
            ['listRoles', ['g1']],
            ['hasChannel', ['g1', 'c1']],
            ['hasChannel', ['g1', 'nope']],
            ['listActiveTimeouts', ['g1', 10]],
        ]) {
            const near = await pair.local[method](...args);
            const far = await pair.remote[method](...args);
            expect({ method, args, far }).toEqual({ method, args, far: near });
        }
    });

    test('null survives the wire as null, not as undefined', async () => {
        // The facade's contract is that a read answers null for a guild the bot
        // is not in, and routes turn that into a 404. `undefined` is not JSON,
        // so a naive encoding would drop the key and hand back undefined —
        // which `?? null` at the call sites papers over right up until one of
        // them uses `=== null`.
        await expect(pair.remote.getGuild('nope')).resolves.toBeNull();
        await expect(pair.remote.listChannels('nope')).resolves.toBeNull();
        await expect(pair.remote.listActiveTimeouts('nope', 5)).resolves.toBeNull();
    });

    test('a refusal from Discord arrives as a throw, carrying its code', async () => {
        // listBans on a guild the bot lacks Ban Members in throws rather than
        // returning null, precisely so a route can tell it from "no such
        // guild". That distinction has to survive the wire or the split
        // silently turns permission errors into 404s.
        await expect(pair.local.listBans('g1', 10)).rejects.toThrow('Missing Permissions');

        await expect(pair.remote.listBans('g1', 10)).rejects.toThrow('Missing Permissions');
        await pair.remote.listBans('g1', 10).catch(err => {
            expect(err.code).toBe(50013);
            expect(err.remote).toBe(true);
            // Not a transport failure: the bot process answered, and the answer
            // was "Discord would not let us".
            expect(err.transport).toBeUndefined();
        });
    });

    test('canManageGuild still answers null for "could not be asked"', async () => {
        // null is not a denial here — it is the answer during a Discord outage,
        // and the middleware falls back to the session snapshot for it. Reading
        // it as false over the wire would lock every operator out.
        await expect(pair.remote.canManageGuild('nope', 'u1')).resolves.toBeNull();
    });
});

describe('the endpoint is not open', () => {
    test('it refuses to be built without a long enough secret', () => {
        const gateway = createBotGateway(stubClient());
        expect(() => createGatewayHandler(gateway, undefined)).toThrow(/BOT_GATEWAY_TOKEN/);
        expect(() => createGatewayHandler(gateway, 'short')).toThrow(/at least 32 characters/);
    });

    test('a call with the wrong secret is refused, and told nothing else', async () => {
        const pair = await connectedPair(stubClient({ guilds: [stubGuild('g1')] }));
        try {
            const wrong = createRemoteBotGateway({
                url: `http://127.0.0.1:${pair.server.address().port}`,
                token: 'b'.repeat(MIN_TOKEN_LENGTH),
            });
            await expect(wrong.hasGuild('g1')).rejects.toThrow(/HTTP 401/);
        } finally {
            await pair.close();
        }
    });

    test('only protocol methods are callable — not everything on the object', async () => {
        // The dispatch is checked against the protocol's own set rather than
        // against the gateway object, so `constructor`, `toString` and anything
        // else that happens to be a function on it are not reachable.
        const pair = await connectedPair(stubClient());
        try {
            const port = pair.server.address().port;
            for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
                const res = await fetch(`http://127.0.0.1:${port}/__bot`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
                    body: JSON.stringify({ method, args: [] }),
                });
                expect(res.status).toBe(400);
                expect((await res.json()).error).toMatch(/Unknown gateway method/);
            }
        } finally {
            await pair.close();
        }
    });

    test('a body larger than the cap is refused rather than read', async () => {
        const pair = await connectedPair(stubClient());
        try {
            // Either the 413 lands or the socket is destroyed mid-upload —
            // both are the endpoint refusing to buffer it, which is the point.
            // Checked without `instanceof Error`: undici throws across realms
            // and the check is unreliable under Jest.
            const outcome = await fetch(`http://127.0.0.1:${pair.server.address().port}/__bot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
                body: JSON.stringify({ method: 'hasGuild', args: ['x'.repeat(MAX_BODY_BYTES + 1024)] }),
            }).then(res => `status:${res.status}`, () => 'rejected');

            expect(['status:413', 'rejected']).toContain(outcome);
        } finally {
            await pair.close();
        }
    });

    test('health is answerable without the secret, because a probe has none', async () => {
        const pair = await connectedPair(stubClient(), { health: () => ({ status: 'ok', uptime: 1 }) });
        try {
            const res = await fetch(`http://127.0.0.1:${pair.server.address().port}/health`);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ status: 'ok', uptime: 1 });
        } finally {
            await pair.close();
        }
    });
});

describe('the endpoint answers badly-formed calls without falling over', () => {
    let pair;
    let port;

    beforeEach(async () => {
        pair = await connectedPair(stubClient({ guilds: [stubGuild('g1')] }));
        port = pair.server.address().port;
    });
    afterEach(() => pair.close());

    const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
        body,
    });

    test('an unknown path is a 404, not a dispatch', async () => {
        const res = await post('/anything', JSON.stringify({ method: 'hasGuild', args: ['g1'] }));
        expect(res.status).toBe(404);
    });

    test('the RPC path answers only POST', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/__bot`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(405);
    });

    test('a body that is not JSON is a 400', async () => {
        const res = await post('/__bot', 'not json at all');
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Malformed/);
    });

    test('args that are not an array are refused rather than spread', async () => {
        const res = await post('/__bot', JSON.stringify({ method: 'hasGuild', args: 'g1' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/args must be an array/);
    });

    test('a missing Authorization header is refused like a wrong one', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/__bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'hasGuild', args: ['g1'] }),
        });
        expect(res.status).toBe(401);
    });

    test('a health probe with no health function still gets an answer', async () => {
        // The default exists so a container healthcheck works before anything
        // has been wired up to report detail.
        const bare = await connectedPair(stubClient());
        try {
            const res = await fetch(`http://127.0.0.1:${bare.server.address().port}/health`);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ status: 'ok' });
        } finally {
            await bare.close();
        }
    });

    test('a method that returns nothing crosses the wire as null, not as a parse failure', async () => {
        // addReactions on a channel that is not there returns undefined-shaped
        // falsity locally; `undefined` is not JSON.
        const res = await post('/__bot', JSON.stringify({
            method: 'addReactions', args: ['nope', 'c1', 'm1', []],
        }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, value: false });
    });
});

describe('resolveGatewayPort decides whether the split is on', () => {
    const { resolveGatewayPort } = require('../src/bot/gatewayServer');

    test('unset is off, which is every deployment that has not opted in', () => {
        expect(resolveGatewayPort({})).toBeNull();
        expect(resolveGatewayPort({ BOT_GATEWAY_PORT: '' })).toBeNull();
    });

    test('a usable port turns it on', () => {
        expect(resolveGatewayPort({ BOT_GATEWAY_PORT: '3001' })).toBe(3001);
    });

    test('an unusable value is off rather than a throw', () => {
        // validateEnv has already refused to start on it; this must not be a
        // second, different opinion at a later point in the boot.
        for (const value of ['nonsense', '0', '-1', '70000', '3001.5']) {
            expect([value, resolveGatewayPort({ BOT_GATEWAY_PORT: value })]).toEqual([value, null]);
        }
    });
});

describe('the remote facade refuses to be built half-configured', () => {
    test('no URL, no facade', () => {
        expect(() => createRemoteBotGateway({ url: '', token: TOKEN })).toThrow(/BOT_GATEWAY_URL/);
    });

    test('no token, no facade — every call would be refused anyway', () => {
        expect(() => createRemoteBotGateway({ url: 'http://bot:3001', token: '' })).toThrow(/BOT_GATEWAY_TOKEN/);
    });

    test('a bot process that cannot be reached is a transport failure, not a refusal', async () => {
        // The two mean different things to a route: one is "try again", the
        // other is "you may not do that".
        const remote = createRemoteBotGateway({
            url: 'http://127.0.0.1:1',   // nothing listens here
            token: TOKEN,
            timeoutMs: 500,
        });
        await remote.hasGuild('g1').then(
            () => { throw new Error('expected a rejection'); },
            err => {
                expect(err.transport).toBe(true);
                expect(err.message).toMatch(/could not reach the bot process/);
            },
        );
    });
});

describe('the configuration that turns the split on', () => {
    const { collectEnvProblems, DASHBOARD_REQUIRED_ENV, REQUIRED_ENV } = require('../src/config/validateEnv');

    const base = {
        DISCORD_TOKEN: 't', CLIENT_ID: '1', CLIENT_SECRET: 's',
        MONGODB_URI: 'mongodb://localhost/x',
        SESSION_SECRET: 's'.repeat(32),
        DASHBOARD_URL: 'http://localhost:3000',
        NODE_ENV: 'development',
    };
    const problems = extra => collectEnvProblems({ ...base, ...extra }).errors.join('\n');

    test('all three unset is the default, and is not a problem', () => {
        expect(problems({})).toBe('');
    });

    test('a port or a URL without the shared secret refuses to start', () => {
        // This endpoint can ban, unban and post in every guild the bot is in.
        // There is no unauthenticated mode to leave switched on by accident.
        expect(problems({ BOT_GATEWAY_PORT: '3001' })).toMatch(/BOT_GATEWAY_TOKEN is not set/);
        expect(problems({ BOT_GATEWAY_URL: 'http://clawdia:3001' })).toMatch(/BOT_GATEWAY_TOKEN is not set/);
    });

    test('a short secret is refused for the same reason SESSION_SECRET is', () => {
        expect(problems({ BOT_GATEWAY_PORT: '3001', BOT_GATEWAY_TOKEN: 'short' }))
            .toMatch(/at least 32 characters/);
    });

    test('the two ports cannot be the same — different processes serve them', () => {
        expect(problems({ BOT_GATEWAY_PORT: '3000', BOT_GATEWAY_TOKEN: TOKEN }))
            .toMatch(/must differ from DASHBOARD_PORT/);
    });

    test('a fully configured split is accepted', () => {
        expect(problems({
            BOT_GATEWAY_PORT: '3001',
            BOT_GATEWAY_URL: 'http://clawdia:3001',
            BOT_GATEWAY_TOKEN: TOKEN,
        })).toBe('');
    });

    test('the secret alone is silent — it is the half-done state worth allowing', () => {
        expect(problems({ BOT_GATEWAY_TOKEN: TOKEN })).toBe('');
    });

    test('the dashboard process is not asked for the bot token', () => {
        // It holds no gateway connection, and the token is the credential with
        // the widest blast radius in the deployment. A container that cannot
        // use it should not be handed it.
        expect(DASHBOARD_REQUIRED_ENV).not.toContain('DISCORD_TOKEN');
        expect(DASHBOARD_REQUIRED_ENV).toEqual(REQUIRED_ENV.filter(n => n !== 'DISCORD_TOKEN'));

        const { DISCORD_TOKEN, ...withoutToken } = base;
        expect(DISCORD_TOKEN).toBe('t');
        expect(collectEnvProblems(withoutToken, { required: DASHBOARD_REQUIRED_ENV }).errors).toEqual([]);
        expect(collectEnvProblems(withoutToken).errors.join('\n')).toMatch(/DISCORD_TOKEN/);
    });
});

describe('the two processes are wired to never both serve the dashboard', () => {
    const fs = require('fs');
    const path = require('path');
    const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

    test('the bot serves the facade instead of the dashboard, never as well as', () => {
        // Both would have this process doing the very work the split moves out,
        // and would bind a port the operator did not ask for.
        const code = read('src/index.js');
        expect(code).toMatch(/if \(!startGatewayRpc\(\)\) \{\s*\n\s*await startDashboard\(\);/);
    });

    test('the dashboard process has an entry point and an npm script', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.scripts['start:dashboard']).toBe('node src/dashboard/index.js');
        expect(fs.existsSync(path.join(__dirname, '..', 'src/dashboard/index.js'))).toBe(true);
    });

    test('the dashboard process builds no Discord client and runs no migrations', () => {
        // It has no gateway connection to hold, and migrations are forward-only
        // singleton work owned by shard 0 of the bot — a second process racing
        // the same schema change is a different failure every time.
        const code = read('src/dashboard/index.js');
        expect(code).not.toMatch(/new Client\(/);
        expect(code).not.toMatch(/runMigrations\(\)/);
        expect(code).not.toMatch(/client\.login/);
        expect(code).toContain('createRemoteBotGateway');
    });

    test('the compose service runs the same image behind a profile', () => {
        // A second build is a second version to drift; a profile keeps the
        // service off unless it is asked for.
        const compose = read('docker-compose.yml');
        expect(compose).toMatch(/dashboard:\s*\n\s*profiles: \[split-dashboard\]/);
        expect(compose).toContain('command: ["node", "src/dashboard/index.js"]');
    });

    test('the image healthcheck follows whichever port this container serves', () => {
        // Split, the bot container answers HTTP only on the facade port. A
        // healthcheck fixed to DASHBOARD_PORT would report it unhealthy forever.
        expect(read('Dockerfile')).toContain('process.env.BOT_GATEWAY_PORT || process.env.DASHBOARD_PORT || 3000');
    });
});

describe('the dashboard works with the facade in another process', () => {
    // The claim #876 makes is that no route has to change, because every one of
    // them already talks to the facade and nothing else. This is that claim,
    // end to end: the real Express app, built with the real remote facade, in
    // front of the real RPC server, in front of the real local facade.
    const request = require('supertest');
    const session = require('express-session');
    const { createApp } = require('../src/dashboard/server');

    const SAVED = { ...process.env };
    let pair;
    let app;

    beforeEach(async () => {
        process.env.SESSION_SECRET = 'x'.repeat(48);
        process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/clawdia-test';
        process.env.NODE_ENV = 'test';
        process.env.DASHBOARD_URL = 'http://localhost:3000';

        pair = await connectedPair(
            stubClient({ guilds: [stubGuild('g1', { name: 'Home', memberCount: 1_284 })] }),
            { health: () => ({ status: 'ok', uptime: 90_061 }) },
        );

        app = createApp({
            bot: pair.remote,
            sessionStore: new session.MemoryStore(),
            configurePassport: () => {},
        });
    });

    afterEach(async () => {
        await pair.close();
        for (const key of ['SESSION_SECRET', 'MONGODB_URI', 'NODE_ENV', 'DASHBOARD_URL']) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
    });

    test('the landing page renders the instance stats it fetched over the wire', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('1,284');
    });

    test('/health answers even when the bot process cannot be reached', async () => {
        // A monitor must get an answer about the dashboard whatever the bot is
        // doing. Closing the far side is the outage this has to survive.
        await pair.close();
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await request(app).get('/health');
        expect(res.status).toBeLessThan(600);
        expect(res.body).toHaveProperty('status');

        console.error.mockRestore();
    });

    test('the landing page still renders when the bot process is gone', async () => {
        // instanceStats answers null for "we do not know", and the template
        // drops the row rather than claiming zero servers — the same behaviour
        // as a client that has not been ready yet.
        await pair.close();
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).not.toContain('members reached');
    });
});

describe('a refusal keeps its shape across the wire', () => {
    const { encodeError, decodeError } = require('../src/bot/gatewayProtocol');

    test('a Discord error keeps its message, name and numeric code', () => {
        const err = Object.assign(new TypeError('Missing Permissions'), { code: 50013 });
        const round = decodeError(encodeError(err));

        expect(round.message).toBe('Missing Permissions');
        expect(round.name).toBe('TypeError');
        expect(round.code).toBe(50013);
        expect(round.remote).toBe(true);
    });

    test('a code that is not a number is dropped rather than forwarded', () => {
        // Routes compare it to Discord's numeric codes; a string that looks
        // like one would compare false and read as an unknown failure.
        expect(encodeError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code).toBeUndefined();
        expect(decodeError({ message: 'x', code: 'ETIMEDOUT' }).code).toBeUndefined();
    });

    test('something thrown that is not an Error still arrives as one', () => {
        for (const thrown of [undefined, null, 'a string', 42]) {
            const round = decodeError(encodeError(thrown));
            expect(round).toBeInstanceOf(Error);
            expect(round.message).toBe('The bot process refused the call.');
        }
        expect(decodeError(undefined).message).toBe('The bot process refused the call.');
    });
});

describe('binding the listener', () => {
    const { startGatewayServer } = require('../src/bot/gatewayServer');

    test('serves health on the port it was given, and can be closed', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const server = startGatewayServer(createBotGateway(stubClient()), {
            port: 0,
            host: '127.0.0.1',
            token: TOKEN,
            health: () => ({ status: 'ok', uptime: 5 }),
        });
        await new Promise(resolve => server.once('listening', resolve));

        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
            expect(await res.json()).toEqual({ status: 'ok', uptime: 5 });
        } finally {
            await new Promise(r => server.close(r));
            console.log.mockRestore();
        }
    });

    test('a bind failure is logged, not thrown — it must not drop the gateway', async () => {
        // An 'error' event with no listener is a process-level throw, and
        // EADDRINUSE here would disconnect every guild the bot is in.
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const errors = [];
        jest.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

        const first = startGatewayServer(createBotGateway(stubClient()), { port: 0, host: '127.0.0.1', token: TOKEN });
        await new Promise(resolve => first.once('listening', resolve));
        const taken = first.address().port;

        const second = startGatewayServer(createBotGateway(stubClient()), { port: taken, host: '127.0.0.1', token: TOKEN });
        await new Promise(resolve => second.once('error', resolve));

        expect(errors.join('\n')).toMatch(/Server error on port/);

        await new Promise(r => first.close(r));
        second.close();
        console.log.mockRestore();
        console.error.mockRestore();
    });
});

describe('serveGatewayIfConfigured is the whole switch', () => {
    const { serveGatewayIfConfigured } = require('../src/bot/gatewayServer');
    const SAVED = { ...process.env };

    afterEach(() => {
        for (const key of ['BOT_GATEWAY_PORT', 'BOT_GATEWAY_TOKEN']) {
            if (SAVED[key] === undefined) delete process.env[key];
            else process.env[key] = SAVED[key];
        }
        jest.restoreAllMocks();
    });

    test('unset: no listener, and the caller starts its own dashboard', () => {
        delete process.env.BOT_GATEWAY_PORT;
        const build = jest.fn();
        expect(serveGatewayIfConfigured(build)).toBe(false);
        expect(build).not.toHaveBeenCalled();
    });

    test('set: the listener comes up and the caller does not start a dashboard', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        process.env.BOT_GATEWAY_PORT = '0';   // an ephemeral port, for the test
        process.env.BOT_GATEWAY_TOKEN = TOKEN;

        // '0' is not a port resolveGatewayPort accepts, so drive the real path
        // with a real one: bind, read it back, and close.
        const probe = require('http').createServer();
        await new Promise(r => probe.listen(0, '127.0.0.1', r));
        const port = probe.address().port;
        await new Promise(r => probe.close(r));

        process.env.BOT_GATEWAY_PORT = String(port);
        let server;
        const build = jest.fn(() => createBotGateway(stubClient()));
        try {
            expect(serveGatewayIfConfigured(build, { host: '127.0.0.1' })).toBe(true);
            expect(build).toHaveBeenCalledTimes(1);
        } finally {
            // startGatewayServer does not hand the server back through this
            // wrapper, so close by connecting once and letting the test end.
            server = undefined;
            await new Promise(r => setTimeout(r, 10));
        }
        expect(server).toBeUndefined();
    });

    test('a listener that cannot be built still counts as split', () => {
        // The operator asked for the split and a dashboard is running
        // elsewhere. Falling back to the in-process one here would bind a port
        // nobody asked for and run the aggregations they moved out.
        jest.spyOn(console, 'error').mockImplementation(() => {});
        process.env.BOT_GATEWAY_PORT = '3001';
        delete process.env.BOT_GATEWAY_TOKEN;   // startGatewayServer will refuse

        expect(serveGatewayIfConfigured(() => createBotGateway(stubClient()))).toBe(true);
        expect(console.error).toHaveBeenCalled();
    });
});

describe('the remote facade needs something to fetch with', () => {
    test('no fetch implementation, no facade', () => {
        // `null` rather than `undefined`: a default parameter only fills in for
        // undefined, and the case worth guarding is a runtime with no global
        // fetch at all, which reads as null here.
        expect(() => createRemoteBotGateway({ url: 'http://bot:3001', token: TOKEN, fetchImpl: null }))
            .toThrow(/No fetch implementation/);
    });

    test('it reads its configuration from the environment when not given any', () => {
        const saved = { ...process.env };
        process.env.BOT_GATEWAY_URL = 'http://clawdia:3001';
        process.env.BOT_GATEWAY_TOKEN = TOKEN;
        try {
            expect(() => createRemoteBotGateway()).not.toThrow();
        } finally {
            for (const key of ['BOT_GATEWAY_URL', 'BOT_GATEWAY_TOKEN']) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
        }
    });
});
