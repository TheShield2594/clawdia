'use strict';

// The dashboard's own entry point (#876).
//
// src/dashboard/index.js is the process the split produces, and it is defined
// as much by what it does not do as by what it does: no Discord client, no
// migrations, no cron jobs. Those absences are the isolation, so they are
// asserted rather than assumed — a require added here that pulls in the bot's
// bootstrap would undo the split without failing anything else.

const EventEmitter = require('events');

// `mock`-prefixed so jest allows the factories below to close over them: the
// factories are hoisted above every other declaration in the file.
const mockConnected = [];
const mockBuilt = [];
const mockListened = [];
const mockMongoEvents = new EventEmitter();

jest.mock('mongoose', () => ({
    connect: jest.fn(async uri => { mockConnected.push(uri); }),
    connection: {
        on: (event, fn) => mockMongoEvents.on(event, fn),
        close: jest.fn(async () => {}),
    },
}));

jest.mock('../src/bot/remoteGateway', () => ({
    createRemoteBotGateway: jest.fn(options => {
        mockBuilt.push(options);
        return { hasGuild: async () => false };
    }),
}));

const mockClosed = [];
jest.mock('../src/dashboard/server', () => ({
    createApp: jest.fn(deps => ({ __app: true, deps })),
    listen: jest.fn(app => {
        mockListened.push(app);
        return { close: cb => { mockClosed.push(true); cb(); } };
    }),
}));

jest.mock('../src/utils/logger', () => ({ installConsoleBridge: jest.fn() }));
jest.mock('../src/config/fileSecrets', () => ({ loadFileSecrets: jest.fn() }));

const SAVED = { ...process.env };

beforeEach(() => {
    mockConnected.length = 0;
    mockBuilt.length = 0;
    mockListened.length = 0;
    mockClosed.length = 0;
    process.env.CLIENT_ID = '1';
    process.env.CLIENT_SECRET = 'secret';
    process.env.MONGODB_URI = 'mongodb://mongo:27017/clawdia';
    process.env.SESSION_SECRET = 's'.repeat(48);
    process.env.DASHBOARD_URL = 'http://localhost:3000';
    process.env.NODE_ENV = 'development';
    process.env.BOT_GATEWAY_URL = 'http://clawdia:3001';
    process.env.BOT_GATEWAY_TOKEN = 't'.repeat(48);
    delete process.env.DISCORD_TOKEN;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in SAVED)) delete process.env[key];
    }
    Object.assign(process.env, SAVED);
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

const load = () => require('../src/dashboard/index');

describe('the dashboard process', () => {
    test('connects to Mongo, builds the remote facade, and listens', async () => {
        await load().main();

        expect(mockConnected).toEqual(['mongodb://mongo:27017/clawdia']);
        expect(mockBuilt).toHaveLength(1);
        expect(mockListened).toHaveLength(1);

        const { createApp } = require('../src/dashboard/server');
        // The facade it built is what the app is handed: this process has no
        // client, so `bot` is the only way it reaches Discord at all.
        expect(createApp).toHaveBeenCalledWith({ bot: expect.objectContaining({ hasGuild: expect.any(Function) }) });
        expect(createApp.mock.calls[0][0]).not.toHaveProperty('client');
    });

    test('exits rather than serving when the database is unreachable', async () => {
        require('mongoose').connect.mockRejectedValueOnce(new Error('no route to host'));
        jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exited'); });

        await expect(load().main()).rejects.toThrow('exited');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(mockListened).toHaveLength(0);
    });

    test('fails before binding a port when it has no bot process to call', async () => {
        // A dashboard that starts and then 500s every page because it cannot
        // reach the bot is worse than one that refuses to start.
        require('../src/bot/remoteGateway').createRemoteBotGateway
            .mockImplementationOnce(() => { throw new Error('BOT_GATEWAY_URL is not set'); });

        await expect(load().main()).rejects.toThrow('BOT_GATEWAY_URL');
        expect(mockListened).toHaveLength(0);
    });

    test('a database hiccup is logged, not fatal — the connection handlers are wired', async () => {
        await load().main();

        expect(() => mockMongoEvents.emit('disconnected')).not.toThrow();
        expect(() => mockMongoEvents.emit('reconnected')).not.toThrow();
        expect(() => mockMongoEvents.emit('error', new Error('blip'))).not.toThrow();
    });

    test('it does not build a Discord client, log in, or run migrations', () => {
        // Reading the source rather than the module graph, because the point is
        // that none of this is even reachable from here.
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'src/dashboard/index.js'), 'utf8');

        expect(src).not.toMatch(/discord\.js/);
        expect(src).not.toMatch(/runMigrations/);
        expect(src).not.toMatch(/startScheduler/);
        expect(src).not.toMatch(/loadCommands|loadEvents/);
    });

    test('a signal closes the listener and the database, then exits cleanly', async () => {
        // A dashboard that exits without draining leaves in-flight requests
        // hanging and the compose stop_grace_period doing nothing.
        const handlers = {};
        jest.spyOn(process, 'on').mockImplementation((signal, fn) => {
            handlers[signal] = fn;
            return process;
        });
        jest.spyOn(process, 'exit').mockImplementation(() => {});

        await load().main();
        expect(Object.keys(handlers)).toEqual(
            expect.arrayContaining(['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException']));

        await handlers.SIGTERM();

        expect(mockClosed).toEqual([true]);
        expect(require('mongoose').connection.close).toHaveBeenCalled();
        expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('a shutdown that goes wrong still exits rather than hanging', async () => {
        const handlers = {};
        jest.spyOn(process, 'on').mockImplementation((signal, fn) => { handlers[signal] = fn; return process; });
        jest.spyOn(process, 'exit').mockImplementation(() => {});
        require('mongoose').connection.close.mockRejectedValueOnce(new Error('already gone'));

        await load().main();
        await handlers.SIGINT();

        expect(process.exit).toHaveBeenCalledWith(0);
    });

    test('an unhandled rejection is logged, not fatal', async () => {
        // src/index.js exits on a spike of these because it has a gateway
        // connection to lose. This process does not: the worst case is one
        // broken page, and exiting turns that into no dashboard at all.
        const handlers = {};
        jest.spyOn(process, 'on').mockImplementation((signal, fn) => { handlers[signal] = fn; return process; });
        jest.spyOn(process, 'exit').mockImplementation(() => {});

        await load().main();
        handlers.unhandledRejection(new Error('a route did something odd'));
        handlers.uncaughtException(new Error('and something else'));

        expect(process.exit).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalled();
    });

    test('it validates its configuration without demanding the bot token', async () => {
        // The credential with the widest blast radius in the deployment, in a
        // container that has no gateway connection to use it with.
        expect(process.env.DISCORD_TOKEN).toBeUndefined();
        await expect(load().main()).resolves.toBeUndefined();
    });
});
