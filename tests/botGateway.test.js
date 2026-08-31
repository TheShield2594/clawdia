'use strict';

const fs = require('fs');
const path = require('path');
const { Collection } = require('@discordjs/collection');

const { createBotGateway, CHANNEL_TYPES } = require('../src/bot/gateway');

// #608: the dashboard was handed the live Discord client and reached through it
// at seventeen call sites — `client.guilds.cache.get(id).channels.cache` and so
// on. That coupled the dashboard's availability to the gateway's and made a
// process split, and sharding, structural impossibilities rather than
// deployment choices: a route holding a live Guild object cannot run in a
// process with no gateway connection, and under sharding that cache holds only
// the guilds routed to this shard.
//
// The facade is the fix, and it is only worth something if two things hold:
// nothing crosses it but ids and plain data, and no route goes around it.

function member(id, { timedOutUntil = null, displayName = null } = {}) {
    return {
        displayName: displayName || `${id}-display`,
        communicationDisabledUntil: timedOutUntil,
        timeout: jest.fn().mockResolvedValue(undefined),
        user: {
            id,
            username: id,
            globalName: null,
            tag: `${id}#0001`,
            displayAvatarURL: () => `https://cdn.example/${id}.webp`,
        },
    };
}

function stubClient({ guilds = {} } = {}) {
    return {
        guilds: { cache: new Collection(Object.entries(guilds)) },
        users: {
            fetch: jest.fn(async id => {
                if (id === 'missing') throw new Error('Unknown User');
                return member(id).user;
            }),
        },
    };
}

function stubGuild(overrides = {}) {
    const message = {
        id: 'm1',
        react: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
    };
    const channel = {
        id: 'c1',
        name: 'general',
        type: CHANNEL_TYPES.TEXT,
        parentId: 'cat1',
        send: jest.fn().mockResolvedValue(message),
        messages: { fetch: jest.fn().mockResolvedValue(message) },
    };
    return {
        message,
        channel,
        guild: {
            id: 'g1',
            name: 'Test Guild',
            icon: 'icon-hash',
            ownerId: 'owner-1',
            memberCount: 42,
            channels: { cache: new Collection([['c1', channel], ['v1', { id: 'v1', name: 'Voice', type: CHANNEL_TYPES.VOICE, parentId: null }]]) },
            roles: { cache: new Collection([['r1', { id: 'r1', name: 'Member', position: 1, managed: false }]]) },
            members: {
                cache: new Collection([
                    ['u1', member('u1', { timedOutUntil: new Date(Date.now() + 60_000) })],
                    ['u2', member('u2')],
                    ['u3', member('u3', { timedOutUntil: new Date(Date.now() - 60_000) })],
                ]),
                search: jest.fn().mockResolvedValue(new Collection([['u1', member('u1')]])),
                fetch: jest.fn(async id => (id === 'gone' ? Promise.reject(new Error('Unknown Member')) : member(id))),
                unban: jest.fn().mockResolvedValue(undefined),
            },
            bans: {
                fetch: jest.fn().mockResolvedValue(new Collection([
                    ['b1', { user: member('b1').user, reason: 'spam' }],
                ])),
            },
            ...overrides,
        },
    };
}

// #558: the dashboard's session carries the guild list Discord returned at OAuth
// time and nothing refreshes it, so the gateway is where a second opinion has to
// come from. `null` is a distinct answer from `false` here — it means nobody
// could say, and callers treat it as "fall back to the snapshot" rather than as
// a denial, so a stub that conflates the two would hide a lockout or a bypass.
describe('canManageGuild', () => {
    const { PermissionFlagsBits } = require('discord.js');

    function memberWith(bits) {
        return { permissions: { has: bit => (bits & bit) === bit } };
    }

    function gatewayFor(fetchImpl, { ownerId = 'owner-1' } = {}) {
        const fixture = stubGuild({ ownerId, members: { fetch: fetchImpl } });
        return createBotGateway(stubClient({ guilds: { g1: fixture.guild } }));
    }

    test('true for a member holding MANAGE_GUILD, and for one holding ADMINISTRATOR', async () => {
        for (const bits of [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.Administrator]) {
            const bot = gatewayFor(async () => memberWith(bits));
            await expect(bot.canManageGuild('g1', 'u1')).resolves.toBe(true);
        }
    });

    test('true for the owner without any member fetch at all', async () => {
        const fetchMember = jest.fn();
        const bot = gatewayFor(fetchMember, { ownerId: 'u1' });

        await expect(bot.canManageGuild('g1', 'u1')).resolves.toBe(true);
        expect(fetchMember).not.toHaveBeenCalled();
    });

    // A cached member is the stale snapshot this method exists to replace, so
    // the fetch has to go to Discord rather than answer from the cache.
    test('forces the fetch past the member cache', async () => {
        const fetchMember = jest.fn(async () => memberWith(PermissionFlagsBits.ManageGuild));
        const bot = gatewayFor(fetchMember);

        await bot.canManageGuild('g1', 'u1');

        expect(fetchMember).toHaveBeenCalledWith({ user: 'u1', force: true });
    });

    test('false for a member who holds neither permission', async () => {
        const bot = gatewayFor(async () => memberWith(PermissionFlagsBits.SendMessages));
        await expect(bot.canManageGuild('g1', 'u1')).resolves.toBe(false);
    });

    // Kicked or banned: Discord answered, and the answer is no.
    test('false when Discord says there is no such member', async () => {
        for (const code of [10007, 10013]) {
            const bot = gatewayFor(async () => { throw Object.assign(new Error('Unknown Member'), { code }); });
            await expect(bot.canManageGuild('g1', 'u1')).resolves.toBe(false);
        }
    });

    test('null when the question could not be asked', async () => {
        const failing = gatewayFor(async () => { throw Object.assign(new Error('Service Unavailable'), { code: 500 }); });
        await expect(failing.canManageGuild('g1', 'u1')).resolves.toBeNull();

        const elsewhere = gatewayFor(async () => memberWith(PermissionFlagsBits.ManageGuild));
        await expect(elsewhere.canManageGuild('nope', 'u1')).resolves.toBeNull();
        await expect(elsewhere.canManageGuild('g1', undefined)).resolves.toBeNull();
    });
});

describe('botGateway hands out data, never live objects', () => {
    let fixture;
    let bot;

    beforeEach(() => {
        fixture = stubGuild();
        bot = createBotGateway(stubClient({ guilds: { g1: fixture.guild } }));
    });

    test('getGuild returns plain fields with no discord.js caches attached', async () => {
        const guild = await bot.getGuild('g1');

        expect(guild).toEqual({
            id: 'g1',
            name: 'Test Guild',
            icon: 'icon-hash',
            ownerId: 'owner-1',
            memberCount: 42,
        });
        expect(guild.channels).toBeUndefined();
        expect(guild.roles).toBeUndefined();
    });

    test('listChannels and listRoles return arrays of plain records', async () => {
        expect(await bot.listChannels('g1')).toEqual([
            { id: 'c1', name: 'general', type: CHANNEL_TYPES.TEXT, parentId: 'cat1' },
            { id: 'v1', name: 'Voice', type: CHANNEL_TYPES.VOICE, parentId: null },
        ]);
        expect(await bot.listRoles('g1')).toEqual([
            { id: 'r1', name: 'Member', position: 1, managed: false },
        ]);
    });

    // The whole facade answers "we are not in that guild" the same way, so a
    // route can keep answering it with one 404 rather than a special case each.
    test('reads return null for a guild the bot is not in', async () => {
        expect(await bot.hasGuild('nope')).toBe(false);
        expect(await bot.getGuild('nope')).toBeNull();
        expect(await bot.listChannels('nope')).toBeNull();
        expect(await bot.listRoles('nope')).toBeNull();
        expect(await bot.hasChannel('nope', 'c1')).toBe(false);
        expect(await bot.listActiveTimeouts('nope', 10)).toBeNull();
        return Promise.all([
            expect(bot.searchMembers('nope', 'a', 5)).resolves.toBeNull(),
            expect(bot.listBans('nope', 10)).resolves.toBeNull(),
            expect(bot.unban('nope', 'u1', 'why')).resolves.toBeNull(),
            expect(bot.clearTimeout('nope', 'u1', 'why')).resolves.toBeNull(),
            expect(bot.sendEmbed('nope', 'c1', {})).resolves.toBeNull(),
        ]);
    });

    test('sendEmbed posts plain embed JSON and returns only the id', async () => {
        const embed = { title: 'Pick a role', color: 0x5865F2 };

        await expect(bot.sendEmbed('g1', 'c1', embed)).resolves.toEqual({ messageId: 'm1' });
        expect(fixture.channel.send).toHaveBeenCalledWith({ embeds: [embed] });
    });

    test('addReactions applies every emoji in order', async () => {
        await bot.addReactions('g1', 'c1', 'm1', ['🎉', 'custom:123']);

        expect(fixture.message.react.mock.calls.map(c => c[0])).toEqual(['🎉', 'custom:123']);
    });

    // A panel whose message is already gone is a cleanup that succeeded, not an
    // error the route has to handle.
    test('deleteMessage swallows a message that is already gone', async () => {
        fixture.channel.messages.fetch.mockRejectedValue(new Error('Unknown Message'));

        await expect(bot.deleteMessage('g1', 'c1', 'm1')).resolves.toBe(false);
    });

    test('listBans returns plain ban records', async () => {
        await expect(bot.listBans('g1', 200)).resolves.toEqual([
            { userId: 'b1', userTag: 'b1#0001', avatarUrl: 'https://cdn.example/b1.webp', reason: 'spam' },
        ]);
    });

    // A missing Ban Members permission is not "no such guild" — the route
    // answers the two differently (503 vs 404), so the facade has to keep them
    // distinguishable.
    test('listBans propagates a refusal from Discord rather than returning null', async () => {
        fixture.guild.bans.fetch.mockRejectedValue(new Error('Missing Permissions'));

        await expect(bot.listBans('g1', 200)).rejects.toThrow('Missing Permissions');
    });

    test('listActiveTimeouts skips members whose timeout has already lapsed', async () => {
        const active = await bot.listActiveTimeouts('g1', 200);

        expect(active.map(t => t.userId)).toEqual(['u1']);
        expect(active[0].expires).toEqual(expect.any(String));
    });

    test('clearTimeout separates a missing member from a missing guild', async () => {
        await expect(bot.clearTimeout('g1', 'gone', 'why')).resolves.toBe('no-member');
        await expect(bot.clearTimeout('g1', 'u1', 'why')).resolves.toBe('ok');
    });

    test('resolveUsers maps unresolvable ids to null rather than dropping them', async () => {
        await expect(bot.resolveUsers(['u1', 'missing'])).resolves.toEqual({
            u1: {
                id: 'u1',
                username: 'u1',
                displayName: 'u1',
                tag: 'u1#0001',
                avatarUrl: 'https://cdn.example/u1.webp',
            },
            missing: null,
        });
    });

    test('searchMembers returns the guild display name, not the account name', async () => {
        await expect(bot.searchMembers('g1', 'u', 10)).resolves.toEqual([
            expect.objectContaining({ id: 'u1', displayName: 'u1-display' }),
        ]);
    });
});

// The facade is only a seam while nothing routes around it. This is the guard:
// if a route reaches for the client again, the coupling is back and sharding
// and a separate dashboard process are impossible again.
describe('nothing in the dashboard touches the client directly', () => {
    const DASHBOARD = path.join(__dirname, '../src/dashboard');

    function walk(dir) {
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...walk(full));
            else if (entry.name.endsWith('.js')) out.push(full);
        }
        return out;
    }

    // Comments are stripped before scanning, so a line explaining why a route
    // no longer imports discord.js does not read as a route importing it.
    const stripComments = text => text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const files = walk(DASHBOARD).map(full => ({
        rel: path.relative(DASHBOARD, full).split(path.sep).join('/'),
        text: stripComments(fs.readFileSync(full, 'utf8')),
    }));

    test('no route or middleware reads req.client', () => {
        expect(files.filter(f => /req\.client/.test(f.text)).map(f => f.rel)).toEqual([]);
    });

    // The reach-through shapes specifically: the ones that only work in a
    // process holding a gateway connection, and that a shard's partial cache
    // silently answers wrong. server.js is where the client arrives and is
    // turned into the facade, so it is the one file allowed to see one.
    test('no route or middleware reaches into the Discord caches', () => {
        const REACH_THROUGH = /\.guilds\.cache|\.channels\.cache|\.roles\.cache|\.members\.cache|client\.users\.fetch|discord\.js/;

        const offenders = files
            .filter(f => f.rel !== 'server.js')
            .filter(f => REACH_THROUGH.test(f.text))
            .map(f => f.rel);

        expect(offenders).toEqual([]);
    });

    test('server.js builds the facade and puts that on the request', () => {
        const server = files.find(f => f.rel === 'server.js').text;

        expect(server).toMatch(/createBotGateway\(client\)/);
        expect(server).toMatch(/req\.bot = bot/);
        expect(server).not.toMatch(/req\.client = client/);
    });
});
