'use strict';

// #1154: checkGuildAccess admits anyone with Manage Server, which let a Manage
// Server user unban or un-timeout through the bot without holding Ban Members or
// Moderate Members. requireGuildPermission is the per-action gate. Driven here
// with real middleware and a stubbed gateway, deny paths first.

const { requireGuildPermission } = require('../src/dashboard/lib/middleware');
const { forgetLiveGuildAccess, snapshotHasPermissions } = require('../src/dashboard/lib/permissions');
const stubBotGateway = require('./helpers/stubBotGateway');

const BAN_MEMBERS = (0x4n).toString();
const MANAGE_GUILD = (0x20n).toString();
const ADMINISTRATOR = (0x8n).toString();

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function makeReq({ live = null, snapshot = MANAGE_GUILD, hasGuildPermissions } = {}) {
    return {
        params: { guildId: 'g1' },
        user: { id: 'user-1', guilds: [{ id: 'g1', permissions: snapshot }] },
        bot: stubBotGateway({ hasGuildPermissions: hasGuildPermissions ?? (async () => live) }),
    };
}

async function run(req, ...names) {
    const res = makeRes();
    const next = jest.fn();
    await requireGuildPermission(...names)(req, res, next);
    return { res, next };
}

beforeEach(() => forgetLiveGuildAccess());

describe('requireGuildPermission', () => {
    test('denies when Discord says the permission is not held', async () => {
        const { res, next } = await run(makeReq({ live: false, snapshot: BAN_MEMBERS }), 'BanMembers');
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    test('admits when Discord says it is held', async () => {
        const { next } = await run(makeReq({ live: true }), 'BanMembers');
        expect(next).toHaveBeenCalled();
    });

    test('asks the gateway for exactly the named permissions', async () => {
        const hasGuildPermissions = jest.fn(async () => true);
        await run(makeReq({ hasGuildPermissions }), 'ModerateMembers');
        expect(hasGuildPermissions).toHaveBeenCalledWith('g1', 'user-1', ['ModerateMembers']);
    });

    describe('when Discord could not be asked, the session snapshot decides', () => {
        test('Manage Server alone is refused', async () => {
            const { res, next } = await run(makeReq({ live: null, snapshot: MANAGE_GUILD }), 'BanMembers');
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        test('the snapshot holding the permission is admitted', async () => {
            const { next } = await run(makeReq({ live: null, snapshot: BAN_MEMBERS }), 'BanMembers');
            expect(next).toHaveBeenCalled();
        });

        test('a throwing gateway falls back rather than admitting', async () => {
            const req = makeReq({ hasGuildPermissions: async () => { throw new Error('down'); }, snapshot: MANAGE_GUILD });
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            const { res } = await run(req, 'Administrator');
            expect(res.statusCode).toBe(403);
        });
    });

    test('an answer about one permission is not reused for another', async () => {
        const hasGuildPermissions = jest.fn(async (_g, _u, names) => names.includes('BanMembers'));
        const req = makeReq({ hasGuildPermissions });
        expect((await run(req, 'BanMembers')).next).toHaveBeenCalled();
        expect((await run(req, 'ModerateMembers')).res.statusCode).toBe(403);
    });

    test('refuses to be built without a permission', () => {
        expect(() => requireGuildPermission()).toThrow();
    });
});

describe('snapshotHasPermissions', () => {
    test('Administrator implies every permission, and the owner holds them all', () => {
        expect(snapshotHasPermissions({ permissions: ADMINISTRATOR }, ['BanMembers', 'ModerateMembers'])).toBe(true);
        expect(snapshotHasPermissions({ owner: true, permissions: '0' }, ['Administrator'])).toBe(true);
    });

    test('Moderate Members sits above bit 31 and is still read correctly', () => {
        expect(snapshotHasPermissions({ permissions: (1n << 40n).toString() }, ['ModerateMembers'])).toBe(true);
        expect(snapshotHasPermissions({ permissions: MANAGE_GUILD }, ['ModerateMembers'])).toBe(false);
    });

    test('fails closed on an unknown name, an empty list or a malformed bitfield', () => {
        expect(snapshotHasPermissions({ permissions: BAN_MEMBERS }, ['BanMembrs'])).toBe(false);
        expect(snapshotHasPermissions({ permissions: BAN_MEMBERS }, [])).toBe(false);
        expect(snapshotHasPermissions({ permissions: 'nope' }, ['BanMembers'])).toBe(false);
        expect(snapshotHasPermissions(undefined, ['BanMembers'])).toBe(false);
    });
});

describe('the dashboard\'s permission bits', () => {
    // Written out in permissions.js because the dashboard process does not load
    // discord.js; this is what keeps the copy honest.
    test('match discord.js', () => {
        const { PermissionFlagsBits } = require('discord.js');
        const { PERMISSION_BITS } = require('../src/dashboard/lib/permissions');
        for (const [name, bit] of Object.entries(PERMISSION_BITS)) {
            expect([name, bit]).toEqual([name, PermissionFlagsBits[name]]);
        }
    });
});
