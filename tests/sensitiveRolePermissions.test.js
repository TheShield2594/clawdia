'use strict';

// #1061: the deny set for self-assignable roles. The two config routes and the
// two event handlers all lean on `sensitivePermissionsOf`, so its edges — how
// it reads a live PermissionsBitField vs. the plain string a route holds, and
// that it does not expand Administrator into the whole list — are pinned here.

const { PermissionFlagsBits } = require('discord.js');
const {
    SENSITIVE_ROLE_PERMISSIONS,
    sensitivePermissionsOf,
    describeSensitivePermissions,
} = require('../src/utils/sensitiveRolePermissions');

describe('sensitivePermissionsOf', () => {
    it('returns nothing for empty, null and unrecognised inputs', () => {
        for (const input of [null, undefined, 0n, 0, '0', '', {}, 'nonsense']) {
            expect(sensitivePermissionsOf(input)).toEqual([]);
        }
    });

    it('reads a live PermissionsBitField (role.permissions)', () => {
        const permissions = { bitfield: PermissionFlagsBits.KickMembers };
        expect(sensitivePermissionsOf(permissions)).toEqual(['KickMembers']);
    });

    it('reads the raw bigint and the decimal string Discord serialises', () => {
        const bits = PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageWebhooks;
        expect(sensitivePermissionsOf(bits)).toEqual(['ManageGuild', 'ManageWebhooks']);
        expect(sensitivePermissionsOf(bits.toString())).toEqual(['ManageGuild', 'ManageWebhooks']);
    });

    it('lists carried permissions in severity order, not input order', () => {
        const bits = PermissionFlagsBits.MentionEveryone | PermissionFlagsBits.Administrator;
        expect(sensitivePermissionsOf(bits)).toEqual(['Administrator', 'MentionEveryone']);
    });

    it('does not expand Administrator into the permissions it implies', () => {
        // A role that only has the Administrator bit reports exactly that, so a
        // message names the one permission it actually carries.
        expect(sensitivePermissionsOf(PermissionFlagsBits.Administrator)).toEqual(['Administrator']);
    });

    it('ignores permissions outside the deny set', () => {
        expect(sensitivePermissionsOf(PermissionFlagsBits.SendMessages | PermissionFlagsBits.AddReactions)).toEqual([]);
    });

    it('every deny-set name is a real Discord permission flag', () => {
        for (const name of SENSITIVE_ROLE_PERMISSIONS) {
            expect(typeof PermissionFlagsBits[name]).toBe('bigint');
        }
    });
});

describe('describeSensitivePermissions', () => {
    it('maps flag names to their human labels', () => {
        expect(describeSensitivePermissions(['Administrator', 'ManageGuild', 'ModerateMembers']))
            .toBe('Administrator, Manage Server, Timeout Members');
    });

    it('handles an empty or missing list', () => {
        expect(describeSensitivePermissions([])).toBe('');
        expect(describeSensitivePermissions()).toBe('');
    });
});
