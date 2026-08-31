'use strict';

// #704: the landing page presented "14,200 servers", "2.1M commands / day" and
// "99.98% uptime · 90d" as facts about the instance a visitor was looking at.
// Every deployment of this bot is self-hosted, so those numbers described
// someone else's install or none at all — and being hardcoded, they were never
// going to become true.
//
// The row is measured now. What these tests hold is the part that is easy to
// get wrong in the other direction: an instance that cannot yet answer must
// render nothing, not zero.

const request = require('supertest');
const session = require('express-session');
const { Collection } = require('@discordjs/collection');

const { createBotGateway } = require('../src/bot/gateway');
const { instanceStats, formatUptime, formatCount } = require('../src/dashboard/lib/instanceStats');

const SAVED_ENV = { ...process.env };

beforeEach(() => {
    process.env.SESSION_SECRET = 'x'.repeat(48);
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/clawdia-test';
    process.env.NODE_ENV = 'test';
});

afterEach(() => {
    for (const key of ['SESSION_SECRET', 'MONGODB_URI', 'NODE_ENV']) {
        if (SAVED_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = SAVED_ENV[key];
    }
    jest.restoreAllMocks();
});

const { createApp } = require('../src/dashboard/server');

function stubClient({ ready = true, guilds = [] } = {}) {
    return {
        readyAt: ready ? new Date() : null,
        guilds: {
            cache: new Collection(guilds.map((g, i) => [g.id ?? `g${i}`, { id: g.id ?? `g${i}`, ...g }])),
        },
    };
}

describe('the gateway reach() the row is built from', () => {
    test('counts the guilds the bot is in and sums their members', async () => {
        const bot = createBotGateway(stubClient({
            guilds: [{ memberCount: 120 }, { memberCount: 8 }, { memberCount: 1_000 }],
        }));

        expect(await bot.reach()).toEqual({ guilds: 3, members: 1_128 });
    });

    // Before READY the cache is empty because nothing has filled it, not
    // because the bot is in no guilds. Reporting 0 there would be the same
    // class of false claim the hardcoded numbers were.
    test('answers null before the client has been ready', async () => {
        expect(await createBotGateway(stubClient({ ready: false, guilds: [{ memberCount: 5 }] })).reach()).toBeNull();
    });

    test('reports zero honestly once ready and in no guilds', async () => {
        expect(await createBotGateway(stubClient({ guilds: [] })).reach()).toEqual({ guilds: 0, members: 0 });
    });

    // A guild Discord has not sent a member count for must not turn the whole
    // sum into NaN, which would render as "NaN members reached".
    test('treats a guild with no member count as contributing none', async () => {
        const bot = createBotGateway(stubClient({
            guilds: [{ memberCount: 40 }, { memberCount: undefined }, { memberCount: null }],
        }));

        expect(await bot.reach()).toEqual({ guilds: 3, members: 40 });
    });

    test('leaks no discord.js object across the facade', async () => {
        const reach = await createBotGateway(stubClient({ guilds: [{ memberCount: 3 }] })).reach();

        expect(Object.keys(reach).sort()).toEqual(['guilds', 'members']);
        expect(Object.values(reach).every(v => typeof v === 'number')).toBe(true);
    });
});

describe('formatUptime', () => {
    test.each([
        [0, '0s'],
        [47, '47s'],
        [8 * 60, '8m 0s'],
        [5 * 3600 + 12 * 60, '5h 12m'],
        [12 * 86400 + 4 * 3600, '12d 4h'],
        [86400, '1d 0h'],
    ])('%is reads as %s', (seconds, expected) => {
        expect(formatUptime(seconds)).toBe(expected);
    });

    // A fresh container reports a small uptime, not a broken one.
    test('never renders a negative or non-numeric uptime', () => {
        expect(formatUptime(-500)).toBe('0s');
        expect(formatUptime(undefined)).toBe('0s');
        expect(formatUptime('nonsense')).toBe('0s');
    });
});

describe('formatCount', () => {
    test('groups thousands the way the row is laid out for', () => {
        expect(formatCount(14_200)).toBe('14,200');
        expect(formatCount(7)).toBe('7');
    });
});

describe('instanceStats', () => {
    const status = uptime => () => ({ status: 'healthy', uptime });

    test('formats what the instance reports', async () => {
        const bot = { reach: () => ({ guilds: 3, members: 14_200 }) };

        expect(await instanceStats(bot, { status: status(90_061) })).toEqual({
            servers: '3',
            members: '14,200',
            uptime: '1d 1h',
        });
    });

    test('is null when the client has not been ready', async () => {
        expect(await instanceStats({ reach: () => null }, { status: status(10) })).toBeNull();
    });

    test('is null for a facade with no reach() at all', async () => {
        expect(await instanceStats({ hasGuild: () => false }, { status: status(10) })).toBeNull();
    });

    // The landing page is the one route that renders for anyone. A throw here
    // must cost the row, never the page.
    test('is null when the facade throws', async () => {
        const bot = { reach: () => { throw new Error('no client'); } };

        expect(await instanceStats(bot, { status: status(10) })).toBeNull();
    });

    test('is null when health cannot be read', async () => {
        const bot = { reach: () => ({ guilds: 1, members: 2 }) };
        const broken = () => { throw new Error('no health'); };

        expect(await instanceStats(bot, { status: broken })).toBeNull();
    });
});

describe('the rendered landing page', () => {
    function buildApp(bot) {
        return createApp({
            bot,
            sessionStore: new session.MemoryStore(),
            configurePassport: () => {},
        });
    }

    test('carries none of the numbers it used to assert', async () => {
        const res = await request(buildApp({ reach: () => ({ guilds: 3, members: 900 }) })).get('/');

        expect(res.status).toBe(200);
        for (const claim of ['14,200', '2.1M', '99.98%', 'commands / day', 'uptime · 90d']) {
            expect(res.text).not.toContain(claim);
        }
    });

    test('shows the instance its own figures', async () => {
        const res = await request(buildApp({ reach: () => ({ guilds: 3, members: 1_284 }) })).get('/');

        expect(res.text).toContain('<b>3</b><span>servers</span>');
        expect(res.text).toContain('<b>1,284</b><span>members reached</span>');
        expect(res.text).toContain('<span>uptime · this instance</span>');
    });

    test('drops the whole row, and still renders, when the bot cannot answer', async () => {
        const res = await request(buildApp({ reach: () => null })).get('/');

        expect(res.status).toBe(200);
        expect(res.text).not.toContain('servers</span>');
        expect(res.text).not.toContain('members reached');
        // The one claim that does not depend on the instance stays.
        expect(res.text).toContain('<b>MIT</b><span>open source</span>');
    });

    test('renders a zero-guild instance as zero rather than hiding it', async () => {
        const res = await request(buildApp({ reach: () => ({ guilds: 0, members: 0 }) })).get('/');

        expect(res.text).toContain('<b>0</b><span>servers</span>');
    });
});
