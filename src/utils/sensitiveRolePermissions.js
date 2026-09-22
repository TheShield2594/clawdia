'use strict';

// The deny set for self-assignable roles (#1061).
//
// Reaction-role panels and autorole both hand a role to a member the member
// asked for, or to every joiner, with nothing the bot itself checks. Discord's
// hierarchy stops the bot assigning a role *above* its own top role, but not one
// carrying `Administrator` (or any of the moderator permissions below) that
// happens to sit under it — a common setup, since operators give the bot a high
// role so it can moderate. A `MANAGE_GUILD`-only dashboard admin who lacks
// `ADMINISTRATOR` themselves can then wire such a role onto a panel and elevate
// members — or themselves — to it.
//
// A role carrying one of these is, for practical purposes, a moderator or an
// admin, which is not what self-service role assignment is for. So the two
// config routes refuse it and the two event handlers refuse to assign it — the
// second closes the gap for a role that gains a permission *after* it was
// configured, and for anything written through the generic `/settings` endpoint.
//
// Ordered most-to-least severe, so a message that lists several reads sensibly.
//
// discord.js is required lazily, inside `sensitivePermissionsOf`, rather than at
// the top of the file: the dashboard routes here only ever call the pure
// `describeSensitivePermissions`, and those route modules are loaded by jsdom
// test suites where pulling in discord.js (and its undici fetch stack) throws.
// The bit computation runs only in the bot process, which has a real Node.

// Discord permission flag names (the keys of PermissionFlagsBits) that make a
// role unsafe to self-assign.
const SENSITIVE_ROLE_PERMISSIONS = Object.freeze([
    'Administrator',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'ManageWebhooks',
    'BanMembers',
    'KickMembers',
    'ModerateMembers',
    'MentionEveryone',
]);

// Human-facing labels for the flag names, for messages a dashboard user or a
// mod-log reader sees. Discord's own UI names some of these differently from
// the API flag, so the label is what people recognise.
const PERMISSION_LABELS = Object.freeze({
    Administrator: 'Administrator',
    ManageGuild: 'Manage Server',
    ManageRoles: 'Manage Roles',
    ManageChannels: 'Manage Channels',
    ManageWebhooks: 'Manage Webhooks',
    BanMembers: 'Ban Members',
    KickMembers: 'Kick Members',
    ModerateMembers: 'Timeout Members',
    MentionEveryone: 'Mention @everyone',
});

// Normalise anything a caller might hold to the raw permission bits. A live
// role hands us a `PermissionsBitField` (`role.permissions`); a route that read
// the gateway facade never touches discord.js and holds only plain data, so a
// bigint, a number, or the decimal string Discord serialises permissions as all
// have to resolve too. Anything unrecognised is "no permissions" rather than a
// throw, because the caller is on a member-join or reaction hot path.
function toPermissionBits(permissions) {
    if (permissions == null) return 0n;
    if (typeof permissions === 'bigint') return permissions;
    if (typeof permissions === 'number') return BigInt(Math.trunc(permissions));
    if (typeof permissions === 'string') {
        try { return BigInt(permissions); } catch { return 0n; }
    }
    const bitfield = permissions.bitfield;
    if (typeof bitfield === 'bigint') return bitfield;
    if (typeof bitfield === 'number') return BigInt(Math.trunc(bitfield));
    if (typeof bitfield === 'string') {
        try { return BigInt(bitfield); } catch { return 0n; }
    }
    return 0n;
}

/**
 * The sensitive permission flag names a set of permissions carries, in severity
 * order. Bits are checked literally — `Administrator` is not expanded to imply
 * the rest — so a role that only has `Administrator` reports exactly that,
 * rather than the whole list, and the message stays honest.
 *
 * @param {import('discord.js').PermissionsBitField|bigint|number|string|null} permissions
 * @returns {string[]} flag names from SENSITIVE_ROLE_PERMISSIONS
 */
function sensitivePermissionsOf(permissions) {
    const bits = toPermissionBits(permissions);
    if (bits === 0n) return [];
    const { PermissionFlagsBits } = require('discord.js');
    return SENSITIVE_ROLE_PERMISSIONS.filter(name => {
        const flag = PermissionFlagsBits[name];
        return (bits & flag) === flag;
    });
}

/**
 * A human-readable list of the deny-set permissions, for a message.
 * `['Administrator', 'ManageGuild']` → `'Administrator, Manage Server'`.
 */
function describeSensitivePermissions(names) {
    return (names || []).map(name => PERMISSION_LABELS[name] || name).join(', ');
}

module.exports = {
    SENSITIVE_ROLE_PERMISSIONS,
    PERMISSION_LABELS,
    sensitivePermissionsOf,
    describeSensitivePermissions,
};
