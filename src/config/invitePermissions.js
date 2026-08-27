const { PermissionFlagsBits } = require('discord.js');

// The permission set the invite URL requests — the single source of truth for
// SETUP_GUIDE.md's invite link, the dashboard's per-guild invite button, and
// FEATURES.md's "Bot Permissions Required" list (tests/invitePermissions.test.js
// holds the three together). It used to be `permissions=8` (Administrator),
// which contradicted the documented minimum set and granted everything (#723).
//
// Keyed by the name Discord's UI shows, which is also the name FEATURES.md
// lists. Each entry names the feature that needs it; add a permission only
// with the feature that uses it, or the "minimum" claim rots.
//
// Deliberately absent: Connect and Speak. The bot never joins voice — there is
// no audio playback, and the temp-voice feature only creates and deletes
// channels, which Manage Channels below covers.
const INVITE_PERMISSIONS = {
    // Baseline: seeing channels and answering in them, with embeds (most
    // command output), files (welcome cards, profile/shop images), reactions
    // (reaction roles, starboard) and history (purge, context reads).
    'View Channels': PermissionFlagsBits.ViewChannel,
    'Send Messages': PermissionFlagsBits.SendMessages,
    'Embed Links': PermissionFlagsBits.EmbedLinks,
    'Attach Files': PermissionFlagsBits.AttachFiles,
    'Read Message History': PermissionFlagsBits.ReadMessageHistory,
    'Add Reactions': PermissionFlagsBits.AddReactions,
    'Use Slash Commands': PermissionFlagsBits.UseApplicationCommands,
    // Moderation: purge and automod deletions; kick/ban/massban; timeouts.
    'Manage Messages': PermissionFlagsBits.ManageMessages,
    'Kick Members': PermissionFlagsBits.KickMembers,
    'Ban Members': PermissionFlagsBits.BanMembers,
    'Moderate Members': PermissionFlagsBits.ModerateMembers,
    // Reaction roles, autorole on join, level/birthday role rewards.
    'Manage Roles': PermissionFlagsBits.ManageRoles,
    // Slowmode, lockdown, anti-nuke recovery, temp voice channel create/delete.
    'Manage Channels': PermissionFlagsBits.ManageChannels,
    // Anti-nuke reads the audit log to attribute mass deletions to an actor.
    'View Audit Log': PermissionFlagsBits.ViewAuditLog,
    // Temp voice: the owner overwrite grants Mute/Deafen, and Discord only
    // lets the bot grant permissions it holds itself; Move puts the joining
    // member into their freshly created channel.
    'Mute Members': PermissionFlagsBits.MuteMembers,
    'Deafen Members': PermissionFlagsBits.DeafenMembers,
    'Move Members': PermissionFlagsBits.MoveMembers,
};

const INVITE_PERMISSIONS_BITFIELD = Object.values(INVITE_PERMISSIONS)
    .reduce((bits, flag) => bits | flag, 0n);

module.exports = { INVITE_PERMISSIONS, INVITE_PERMISSIONS_BITFIELD };
