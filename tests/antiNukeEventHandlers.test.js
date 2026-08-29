'use strict';

// The four audit-log handlers are four lines each and did the same thing wrong
// would be invisible: they forward a gateway event to antiNukeService.trackAction
// with the action name and the AuditLogEvent that names the executor. Get either
// wrong and the burst counter counts the wrong thing — a role deletion filed
// under `roleCreate` never trips the roleDelete threshold, and an audit type that
// does not match the event resolves no executor at all, so nothing is ever
// counted.
//
// Nothing else in the repo pins that pairing, so these are the tests for it.
// The AuditLogEvent values come from discord.js itself rather than a mock, so a
// handler naming a constant that does not exist fails here rather than shipping
// an `undefined` audit type.

const { AuditLogEvent } = require('discord.js');

jest.mock('../src/services/antiNukeService', () => ({ trackAction: jest.fn() }));
const { trackAction } = require('../src/services/antiNukeService');

const guildBanAdd = require('../src/events/guildBanAdd');
const roleCreate = require('../src/events/roleCreate');
const roleDelete = require('../src/events/roleDelete');
const webhooksUpdate = require('../src/events/webhooksUpdate');

const guild = { id: '111222333444555666' };

beforeEach(() => {
    jest.clearAllMocks();
    trackAction.mockResolvedValue(undefined);
});

describe('the handlers are registered under the gateway event they handle', () => {
    // client.on(handler.name, ...) is how these get wired, so a typo here is a
    // handler that never runs at all.
    test.each([
        [guildBanAdd, 'guildBanAdd'],
        [roleCreate, 'roleCreate'],
        [roleDelete, 'roleDelete'],
        [webhooksUpdate, 'webhooksUpdate'],
    ])('%#: %o', (handler, name) => {
        expect(handler.name).toBe(name);
    });
});

describe('guildBanAdd', () => {
    it('counts the ban against the ban threshold, keyed to the banned user', async () => {
        await guildBanAdd.execute({ guild, user: { id: '777' } });

        expect(trackAction).toHaveBeenCalledWith(guild, 'ban', AuditLogEvent.MemberBanAdd, '777');
    });

    it('swallows a trackAction rejection rather than leaving it unhandled', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        trackAction.mockRejectedValue(new Error('audit log fetch failed'));

        await expect(guildBanAdd.execute({ guild, user: { id: '777' } })).resolves.toBeUndefined();
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });
});

describe('roleCreate / roleDelete', () => {
    it('files a created role under roleCreate', async () => {
        await roleCreate.execute({ guild, id: 'role-1' });

        expect(trackAction).toHaveBeenCalledWith(guild, 'roleCreate', AuditLogEvent.RoleCreate, 'role-1');
    });

    it('files a deleted role under roleDelete', async () => {
        await roleDelete.execute({ guild, id: 'role-1' });

        expect(trackAction).toHaveBeenCalledWith(guild, 'roleDelete', AuditLogEvent.RoleDelete, 'role-1');
    });

    it('does not use the same audit type for both', () => {
        // The two handlers are otherwise identical, which is exactly how a
        // copy-paste leaves one of them counting the other's events.
        expect(AuditLogEvent.RoleCreate).not.toBe(AuditLogEvent.RoleDelete);
    });
});

describe('webhooksUpdate', () => {
    // Discord fires one event for create, update and delete alike, so the
    // handler passes no target id and lets the audit lookup decide whether a
    // creation is what actually happened.
    it('counts a webhook change against the webhookCreate threshold', async () => {
        await webhooksUpdate.execute({ guild });

        expect(trackAction).toHaveBeenCalledWith(guild, 'webhookCreate', AuditLogEvent.WebhookCreate, null);
    });

    it('ignores a channel with no guild', async () => {
        // A DM channel has no guild, and antiNukeService reads guild.id first
        // thing — so this is the guard that keeps a TypeError out of the
        // gateway's event loop.
        await webhooksUpdate.execute({ guild: null });
        await webhooksUpdate.execute(null);
        await webhooksUpdate.execute(undefined);

        expect(trackAction).not.toHaveBeenCalled();
    });
});
