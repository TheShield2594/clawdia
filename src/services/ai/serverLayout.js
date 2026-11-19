'use strict';

const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

/**
 * Letting the model look at, and change, how a server is laid out.
 *
 * Two tools, deliberately unequal:
 *
 *   review_server_layout  read-only. The categories, channels and roles as they
 *                         stand, with ids, so a plan can name what it changes.
 *   apply_layout          one approved plan of ordered changes — categories,
 *                         channels, permission overwrites, messages, roles, the
 *                         server's own settings — run top to bottom.
 *
 * One tool for every write, rather than a tool per change, because "redo the
 * layout" is thirty changes and thirty approval prompts is not an approval
 * anybody reads. The person sees the whole plan in plain words once, says yes
 * or no to all of it, and the model is told afterwards exactly which steps
 * landed and which did not.
 *
 * The approval buttons are not the permission. They are answerable by whoever
 * asked, so every step checks again, at the moment it runs, that the person who
 * asked could have made that change by hand: Manage Channels for structure,
 * Manage Roles for overwrites and roles (and only bits they hold themselves),
 * Manage Server for the server's settings, and the right to post wherever a
 * message is going. The bot's own permissions are Discord's to enforce, and a
 * refusal comes back as that step's failure.
 */

// A layout is a few dozen changes; past this the plan is not something a person
// reads before clicking, and each step is a Discord request with its own rate
// limit.
const MAX_OPERATIONS = 40;

// Discord's own ceilings.
const MAX_MESSAGE_LENGTH = 2000;
const MAX_TOPIC_LENGTH = 1024;
const MAX_NAME_LENGTH = 100;
const MAX_SLOWMODE_SECONDS = 21600;
const AFK_TIMEOUTS = [60, 300, 900, 1800, 3600];

// What the review lists before it stops: a server with more than this is not
// read whole, and the tool result would be trimmed anyway.
const MAX_REVIEW_CHANNELS = 250;
const MAX_REVIEW_ROLES = 50;

const ACTIONS = [
    'create_category', 'create_channel', 'edit_channel', 'delete_channel',
    'set_permissions', 'post_message', 'edit_server', 'create_role', 'edit_role'
];

const CHANNEL_TYPES = {
    text: ChannelType.GuildText,
    voice: ChannelType.GuildVoice,
    announcement: ChannelType.GuildAnnouncement,
    forum: ChannelType.GuildForum,
    stage: ChannelType.GuildStageVoice
};

const TYPE_LABELS = {
    [ChannelType.GuildText]: 'text',
    [ChannelType.GuildVoice]: 'voice',
    [ChannelType.GuildCategory]: 'category',
    [ChannelType.GuildAnnouncement]: 'announcement',
    [ChannelType.GuildForum]: 'forum',
    [ChannelType.GuildStageVoice]: 'stage',
    [ChannelType.GuildMedia]: 'media'
};

// Types a topic means something on.
const TOPIC_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);

// Permission names, matched loosely: "Send Messages", "send_messages" and
// "SendMessages" are the same thing to whoever wrote the request.
const PERMISSION_KEYS = new Map(
    Object.keys(PermissionFlagsBits).map(key => [squash(key), key])
);

function squash(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** How Discord spells a channel name, for comparing one somebody typed. */
function normalizeName(text) {
    return String(text || '').trim().replace(/^#/, '').toLowerCase().replace(/[\s_-]+/g, '-');
}

// A name, a topic or a message, on one line and with nothing that renders as
// formatting, for the approval preview and the tool's own answers.
function inline(text, limit = 80) {
    const flat = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[`*_~|>]/g, '').trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function isThread(channel) {
    return typeof channel?.isThread === 'function' ? channel.isThread() : false;
}

// ---------------------------------------------------------------------------
// Resolving what a step names
// ---------------------------------------------------------------------------

class StepError extends Error {}

function snowflakeOf(ref) {
    const text = String(ref || '').trim();
    const mention = text.match(/^<[#@][&!]?(\d{15,25})>$/);
    if (mention) return mention[1];
    return /^\d{15,25}$/.test(text) ? text : null;
}

/**
 * A channel or category by id, mention or name.
 *
 * Names that were created earlier in the same plan win, so a plan can create
 * "Community" and then put three channels in it without knowing an id that did
 * not exist when the plan was written. A name two channels share is refused
 * rather than guessed at: changing the wrong one is worse than asking.
 */
function resolveChannel(guild, ref, created, { categoryOnly = false } = {}) {
    const id = snowflakeOf(ref);
    if (id) {
        const channel = guild.channels.cache.get(id);
        if (!channel || isThread(channel)) throw new StepError(`there is no channel with id ${id}`);
        if (categoryOnly && channel.type !== ChannelType.GuildCategory) {
            throw new StepError(`${id} is not a category`);
        }
        return channel;
    }

    const wanted = normalizeName(ref);
    if (!wanted) throw new StepError('no channel was named');

    const fromPlan = created.filter(channel =>
        normalizeName(channel.name) === wanted
        && (!categoryOnly || channel.type === ChannelType.GuildCategory));
    if (fromPlan.length) return fromPlan[fromPlan.length - 1];

    const matches = [...guild.channels.cache.values()].filter(channel =>
        !isThread(channel)
        && normalizeName(channel.name) === wanted
        && (!categoryOnly || channel.type === ChannelType.GuildCategory));

    if (!matches.length) {
        throw new StepError(`there is no ${categoryOnly ? 'category' : 'channel'} named "${inline(ref, 60)}"`);
    }
    if (matches.length > 1) {
        throw new StepError(`${matches.length} channels are named "${inline(ref, 60)}" — use the id instead `
            + `(${matches.map(channel => channel.id).join(', ')})`);
    }
    return matches[0];
}

/** A role by id, mention or name; "@everyone" and "everyone" are the guild's own. */
function resolveRole(guild, ref) {
    const text = String(ref || '').trim();
    if (!text) throw new StepError('no role was named');
    if (/^@?everyone$/i.test(text)) return guild.roles.everyone;

    const id = snowflakeOf(text);
    if (id) {
        const role = guild.roles.cache.get(id);
        if (!role) throw new StepError(`there is no role with id ${id}`);
        return role;
    }

    const wanted = text.replace(/^@/, '').toLowerCase();
    const matches = [...guild.roles.cache.values()].filter(role => role.name.toLowerCase() === wanted);
    if (!matches.length) throw new StepError(`there is no role named "${inline(text, 60)}"`);
    if (matches.length > 1) {
        throw new StepError(`${matches.length} roles are named "${inline(text, 60)}" — use the id instead`);
    }
    return matches[0];
}

/** Who an overwrite is for: a role, @everyone, or one member by mention or id. */
async function resolveOverwriteTarget(guild, ref) {
    const text = String(ref || '').trim();
    const memberMention = text.match(/^<@!?(\d{15,25})>$/);
    if (memberMention) {
        const member = await guild.members.fetch(memberMention[1]).catch(() => null);
        if (!member) throw new StepError(`<@${memberMention[1]}> is not a member of this server`);
        return { id: member.id, label: member.user?.username || member.id };
    }

    try {
        const role = resolveRole(guild, text);
        return { id: role.id, label: role.id === guild.id ? '@everyone' : `@${role.name}` };
    } catch (err) {
        // A bare id that is not a role may be a member.
        const id = snowflakeOf(text);
        if (!id) throw err;
        const member = await guild.members.fetch(id).catch(() => null);
        if (!member) throw err;
        return { id: member.id, label: member.user?.username || member.id };
    }
}

function permissionNames(list, field) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new StepError(`${field} must be a list of permission names`);
    return list.map(name => {
        const key = PERMISSION_KEYS.get(squash(name));
        if (!key) throw new StepError(`"${inline(name, 40)}" in ${field} is not a Discord permission`);
        if (key === 'Administrator') throw new StepError('Administrator cannot be set on a channel');
        return key;
    });
}

// ---------------------------------------------------------------------------
// Checking the person who asked
// ---------------------------------------------------------------------------

function isOwner(member) {
    return Boolean(member?.guild && member.guild.ownerId === member.id);
}

function requireGuildPermission(member, flag, label) {
    if (!member?.permissions?.has(PermissionFlagsBits[flag])) {
        throw new StepError(`you need ${label} for this`);
    }
}

function requireChannelPermission(member, channel, flags, label) {
    const perms = channel.permissionsFor?.(member);
    const missing = flags.filter(flag => !perms?.has(PermissionFlagsBits[flag]));
    if (missing.length) throw new StepError(`you need ${label} in #${inline(channel.name, 60)} for this`);
}

/** A role the person who asked could edit by hand: below their own highest. */
function requireRoleBelow(member, role) {
    if (role.managed) throw new StepError(`@${inline(role.name, 60)} is managed by an integration and cannot be edited`);
    if (isOwner(member)) return;
    const highest = member?.roles?.highest?.position ?? 0;
    if (role.position >= highest) {
        throw new StepError(`@${inline(role.name, 60)} is not below your highest role, so you could not edit it yourself`);
    }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

function cleanName(value, field = 'name') {
    const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) throw new StepError(`${field} is required`);
    if (text.length > MAX_NAME_LENGTH) throw new StepError(`${field} is longer than ${MAX_NAME_LENGTH} characters`);
    return text;
}

function slowmodeOf(value) {
    if (value === undefined || value === null) return undefined;
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_SLOWMODE_SECONDS) {
        throw new StepError(`slowmode must be a whole number of seconds from 0 to ${MAX_SLOWMODE_SECONDS}`);
    }
    return seconds;
}

function topicOf(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value);
    if (text.length > MAX_TOPIC_LENGTH) throw new StepError(`topic is longer than ${MAX_TOPIC_LENGTH} characters`);
    return text;
}

function positionOf(value) {
    if (value === undefined || value === null) return undefined;
    const position = Number(value);
    if (!Number.isInteger(position) || position < 0) throw new StepError('position must be a whole number from 0');
    return position;
}

function colorOf(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const match = String(value).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!match) throw new StepError('color must be a hex colour like #5865F2');
    return parseInt(match[1], 16);
}

function label(channel) {
    return channel.type === ChannelType.GuildCategory
        ? `category "${inline(channel.name, 60)}"`
        : `#${inline(channel.name, 60)}`;
}

const STEPS = {
    async create_category(op, ctx) {
        requireGuildPermission(ctx.member, 'ManageChannels', 'Manage Channels');
        const name = cleanName(op.name);
        const options = { name, type: ChannelType.GuildCategory, reason: ctx.reason };
        const position = positionOf(op.position);
        if (position !== undefined) options.position = position;
        const category = await ctx.guild.channels.create(options);
        ctx.created.push(category);
        return `created category "${inline(category.name, 60)}" (${category.id})`;
    },

    async create_channel(op, ctx) {
        requireGuildPermission(ctx.member, 'ManageChannels', 'Manage Channels');
        const name = cleanName(op.name);
        const typeKey = op.type ?? 'text';
        const type = CHANNEL_TYPES[typeKey];
        if (type === undefined) throw new StepError(`"${inline(typeKey, 20)}" is not a channel type I can create`);

        const options = { name, type, reason: ctx.reason };
        let parent = null;
        if (op.category) {
            parent = resolveChannel(ctx.guild, op.category, ctx.created, { categoryOnly: true });
            requireChannelPermission(ctx.member, parent, ['ManageChannels'], 'Manage Channels');
            options.parent = parent.id;
        }
        const topic = topicOf(op.topic);
        if (topic !== undefined && TOPIC_TYPES.has(type)) options.topic = topic;
        if (typeof op.nsfw === 'boolean') options.nsfw = op.nsfw;
        const slowmode = slowmodeOf(op.slowmode);
        if (slowmode !== undefined) options.rateLimitPerUser = slowmode;
        const position = positionOf(op.position);
        if (position !== undefined) options.position = position;

        const channel = await ctx.guild.channels.create(options);
        ctx.created.push(channel);
        return `created ${TYPE_LABELS[type]} channel #${inline(channel.name, 60)} (${channel.id})`
            + (parent ? ` in ${label(parent)}` : '');
    },

    async edit_channel(op, ctx) {
        const channel = resolveChannel(ctx.guild, op.channel, ctx.created);
        requireChannelPermission(ctx.member, channel, ['ManageChannels'], 'Manage Channels');

        const changes = {};
        const said = [];
        if (op.name !== undefined && op.name !== null) {
            changes.name = cleanName(op.name);
            said.push(`renamed to "${inline(changes.name, 60)}"`);
        }
        const topic = topicOf(op.topic);
        if (topic !== undefined) {
            if (!TOPIC_TYPES.has(channel.type)) throw new StepError(`${label(channel)} cannot have a topic`);
            changes.topic = topic;
            said.push(topic ? 'topic set' : 'topic cleared');
        }
        if (typeof op.nsfw === 'boolean') {
            changes.nsfw = op.nsfw;
            said.push(op.nsfw ? 'marked age-restricted' : 'no longer age-restricted');
        }
        const slowmode = slowmodeOf(op.slowmode);
        if (slowmode !== undefined) {
            changes.rateLimitPerUser = slowmode;
            said.push(slowmode ? `slowmode ${slowmode}s` : 'slowmode off');
        }
        if (op.category !== undefined && op.category !== null) {
            if (channel.type === ChannelType.GuildCategory) throw new StepError('a category cannot go inside another category');
            if (/^(none|null|)$/i.test(String(op.category).trim())) {
                changes.parent = null;
                said.push('taken out of its category');
            } else {
                const parent = resolveChannel(ctx.guild, op.category, ctx.created, { categoryOnly: true });
                requireChannelPermission(ctx.member, parent, ['ManageChannels'], 'Manage Channels');
                changes.parent = parent.id;
                said.push(`moved into ${label(parent)}`);
            }
        }
        if (typeof op.sync_permissions === 'boolean' && op.sync_permissions) {
            changes.lockPermissions = true;
            said.push('permissions synced to its category');
        }
        const position = positionOf(op.position);
        if (position !== undefined) {
            changes.position = position;
            said.push(`moved to position ${position}`);
        }

        if (!said.length) throw new StepError('the step changes nothing');
        await channel.edit({ ...changes, reason: ctx.reason });
        return `${label(channel)}: ${said.join(', ')}`;
    },

    async delete_channel(op, ctx) {
        const channel = resolveChannel(ctx.guild, op.channel, ctx.created);
        requireChannelPermission(ctx.member, channel, ['ManageChannels'], 'Manage Channels');
        // The reply to this very request is going here, and so is the record of
        // what the plan did.
        if (channel.id === ctx.channel?.id) throw new StepError('this conversation is in that channel, so I will not delete it');
        const was = label(channel);
        await channel.delete(ctx.reason);
        return `deleted ${was}`;
    },

    async set_permissions(op, ctx) {
        const channel = resolveChannel(ctx.guild, op.channel, ctx.created);
        requireChannelPermission(ctx.member, channel, ['ManageRoles'], 'Manage Permissions');
        const target = await resolveOverwriteTarget(ctx.guild, op.target);

        if (op.reset === true) {
            await channel.permissionOverwrites.delete(target.id, ctx.reason);
            return `${label(channel)}: removed the overwrite for ${target.label}`;
        }

        const allow = permissionNames(op.allow, 'allow');
        const deny = permissionNames(op.deny, 'deny');
        const clear = permissionNames(op.clear, 'clear');
        if (!allow.length && !deny.length && !clear.length) throw new StepError('the step changes no permissions');
        const both = allow.filter(name => deny.includes(name));
        if (both.length) throw new StepError(`${both.join(', ')} is in both allow and deny`);

        // Discord stops the bot granting what the bot lacks; nothing stops it
        // granting what the person who asked lacks. So that is checked here.
        const own = channel.permissionsFor?.(ctx.member);
        if (!own?.has(PermissionFlagsBits.Administrator)) {
            const beyond = [...allow, ...deny].filter(name => !own?.has(PermissionFlagsBits[name]));
            if (beyond.length) {
                throw new StepError(`you do not have ${beyond.join(', ')} there yourself, so you cannot set it for others`);
            }
        }

        const edit = {};
        for (const name of allow) edit[name] = true;
        for (const name of deny) edit[name] = false;
        for (const name of clear) edit[name] = null;
        await channel.permissionOverwrites.edit(target.id, edit, { reason: ctx.reason });

        const parts = [];
        if (allow.length) parts.push(`allow ${allow.join(', ')}`);
        if (deny.length) parts.push(`deny ${deny.join(', ')}`);
        if (clear.length) parts.push(`inherit ${clear.join(', ')}`);
        return `${label(channel)}: ${target.label} — ${parts.join('; ')}`;
    },

    async post_message(op, ctx) {
        const channel = resolveChannel(ctx.guild, op.channel, ctx.created);
        if (channel.type === ChannelType.GuildCategory || typeof channel.send !== 'function'
            || channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
            throw new StepError(`${label(channel)} is not somewhere a message can be posted`);
        }
        const content = String(op.content ?? '').trim();
        if (!content) throw new StepError('the message is empty');
        if (content.length > MAX_MESSAGE_LENGTH) throw new StepError(`the message is longer than ${MAX_MESSAGE_LENGTH} characters`);

        // The bot posts with its own permissions, so this is what keeps it from
        // being a way into a channel the person who asked cannot post in.
        requireChannelPermission(ctx.member, channel, ['ViewChannel', 'SendMessages'], 'Send Messages');

        // A ping goes out only if the person who asked could have sent it.
        const canPingAll = channel.permissionsFor?.(ctx.member)?.has(PermissionFlagsBits.MentionEveryone);
        const sent = await channel.send({
            content,
            allowedMentions: canPingAll ? { parse: ['users', 'roles', 'everyone'] } : { parse: ['users'] }
        });
        return `posted in #${inline(channel.name, 60)}${sent?.id ? ` (message ${sent.id})` : ''}`;
    },

    async edit_server(op, ctx) {
        requireGuildPermission(ctx.member, 'ManageGuild', 'Manage Server');
        const changes = {};
        const said = [];
        if (op.name !== undefined && op.name !== null) {
            changes.name = cleanName(op.name);
            said.push(`renamed to "${inline(changes.name, 60)}"`);
        }
        if (op.system_channel !== undefined && op.system_channel !== null) {
            if (/^(none|null|)$/i.test(String(op.system_channel).trim())) {
                changes.systemChannel = null;
                said.push('system messages turned off');
            } else {
                const channel = resolveChannel(ctx.guild, op.system_channel, ctx.created);
                if (channel.type !== ChannelType.GuildText) throw new StepError('the system channel has to be a text channel');
                changes.systemChannel = channel.id;
                said.push(`system messages go to #${inline(channel.name, 60)}`);
            }
        }
        if (op.afk_channel !== undefined && op.afk_channel !== null) {
            if (/^(none|null|)$/i.test(String(op.afk_channel).trim())) {
                changes.afkChannel = null;
                said.push('AFK channel removed');
            } else {
                const channel = resolveChannel(ctx.guild, op.afk_channel, ctx.created);
                if (channel.type !== ChannelType.GuildVoice) throw new StepError('the AFK channel has to be a voice channel');
                changes.afkChannel = channel.id;
                said.push(`AFK channel is #${inline(channel.name, 60)}`);
            }
        }
        if (op.afk_timeout !== undefined && op.afk_timeout !== null) {
            const seconds = Number(op.afk_timeout);
            if (!AFK_TIMEOUTS.includes(seconds)) throw new StepError(`afk_timeout must be one of ${AFK_TIMEOUTS.join(', ')} seconds`);
            changes.afkTimeout = seconds;
            said.push(`AFK after ${seconds / 60} min`);
        }
        if (!said.length) throw new StepError('the step changes nothing');
        await ctx.guild.edit({ ...changes, reason: ctx.reason });
        return `server: ${said.join(', ')}`;
    },

    // Roles are created and edited without permission bits on purpose: a plan
    // that could hand out Ban Members or Administrator is a privilege change,
    // and that belongs in Server Settings with a person's own hands on it.
    async create_role(op, ctx) {
        requireGuildPermission(ctx.member, 'ManageRoles', 'Manage Roles');
        const name = cleanName(op.name);
        const options = { name, permissions: [], reason: ctx.reason };
        const color = colorOf(op.color);
        if (color !== undefined) options.color = color;
        if (typeof op.hoist === 'boolean') options.hoist = op.hoist;
        if (typeof op.mentionable === 'boolean') options.mentionable = op.mentionable;
        const role = await ctx.guild.roles.create(options);
        return `created role @${inline(role.name, 60)} (${role.id}) with no permissions of its own`;
    },

    async edit_role(op, ctx) {
        requireGuildPermission(ctx.member, 'ManageRoles', 'Manage Roles');
        const role = resolveRole(ctx.guild, op.role);
        if (role.id === ctx.guild.id) throw new StepError('@everyone cannot be renamed or recoloured');
        requireRoleBelow(ctx.member, role);

        const changes = {};
        const said = [];
        if (op.name !== undefined && op.name !== null) {
            changes.name = cleanName(op.name);
            said.push(`renamed to "${inline(changes.name, 60)}"`);
        }
        const color = colorOf(op.color);
        if (color !== undefined) {
            changes.color = color;
            said.push(`colour #${color.toString(16).padStart(6, '0')}`);
        }
        if (typeof op.hoist === 'boolean') {
            changes.hoist = op.hoist;
            said.push(op.hoist ? 'shown separately' : 'not shown separately');
        }
        if (typeof op.mentionable === 'boolean') {
            changes.mentionable = op.mentionable;
            said.push(op.mentionable ? 'mentionable' : 'not mentionable');
        }
        if (!said.length) throw new StepError('the step changes nothing');
        const was = role.name;
        await role.edit({ ...changes, reason: ctx.reason });
        return `@${inline(was, 60)}: ${said.join(', ')}`;
    }
};

// ---------------------------------------------------------------------------
// The plan as a whole
// ---------------------------------------------------------------------------

/**
 * Shape problems that make a plan unrunnable, found before anything changes.
 *
 * Names are resolved as each step runs, because a step may name a channel an
 * earlier one creates. What can be known up front — a missing action, an
 * unknown permission, too many steps — is refused as a whole, so the model
 * fixes the plan rather than the server being left half-changed by it.
 */
function validatePlan(args) {
    const operations = args?.operations;
    if (!Array.isArray(operations) || !operations.length) return 'The plan has no operations.';
    if (operations.length > MAX_OPERATIONS) {
        return `The plan has ${operations.length} operations; the most one plan can run is ${MAX_OPERATIONS}. Split it in two.`;
    }
    const problems = [];
    operations.forEach((op, index) => {
        const n = index + 1;
        if (!op || typeof op !== 'object') { problems.push(`${n}: not an object`); return; }
        if (!ACTIONS.includes(op.action)) { problems.push(`${n}: "${inline(op.action, 30)}" is not an action`); return; }
        const needs = {
            create_category: ['name'], create_channel: ['name'], edit_channel: ['channel'],
            delete_channel: ['channel'], set_permissions: ['channel', 'target'], post_message: ['channel', 'content'],
            create_role: ['name'], edit_role: ['role'], edit_server: []
        }[op.action];
        for (const field of needs) {
            if (op[field] === undefined || op[field] === null || op[field] === '') problems.push(`${n} (${op.action}): ${field} is required`);
        }
        if (op.action === 'set_permissions' && op.reset !== true) {
            for (const field of ['allow', 'deny', 'clear']) {
                try { permissionNames(op[field], field); } catch (err) { problems.push(`${n} (set_permissions): ${err.message}`); }
            }
        }
    });
    return problems.length ? `The plan was not run — nothing was changed. Fix these and try again:\n${problems.join('\n')}` : null;
}

/** One step in words, for the approval prompt. */
function describeStep(op) {
    const name = value => `"${inline(value, 60)}"`;
    switch (op?.action) {
        case 'create_category':
            return `➕ Create category ${name(op.name)}`;
        case 'create_channel': {
            const extras = [];
            if (op.category) extras.push(`in ${name(op.category)}`);
            if (op.topic) extras.push(`topic: ${name(op.topic)}`);
            if (op.nsfw) extras.push('age-restricted');
            if (op.slowmode) extras.push(`slowmode ${op.slowmode}s`);
            return `➕ Create ${inline(op.type || 'text', 20)} channel ${name(op.name)}${extras.length ? ` — ${extras.join(', ')}` : ''}`;
        }
        case 'edit_channel': {
            const parts = [];
            if (op.name) parts.push(`rename to ${name(op.name)}`);
            if (op.category !== undefined && op.category !== null) parts.push(/^(none|null|)$/i.test(String(op.category)) ? 'take out of its category' : `move into ${name(op.category)}`);
            if (op.topic !== undefined && op.topic !== null) parts.push(op.topic ? `topic: ${name(op.topic)}` : 'clear topic');
            if (typeof op.nsfw === 'boolean') parts.push(op.nsfw ? 'age-restrict' : 'un-age-restrict');
            if (op.slowmode !== undefined && op.slowmode !== null) parts.push(`slowmode ${op.slowmode}s`);
            if (op.sync_permissions) parts.push('sync permissions to category');
            if (op.position !== undefined && op.position !== null) parts.push(`position ${op.position}`);
            return `✏️ Edit ${name(op.channel)}: ${parts.join(', ') || 'no changes'}`;
        }
        case 'delete_channel':
            return `🗑️ **Delete** ${name(op.channel)}`;
        case 'set_permissions': {
            if (op.reset) return `🔒 ${name(op.channel)}: remove the overwrite for ${name(op.target)}`;
            const parts = [];
            if (op.allow?.length) parts.push(`allow ${op.allow.map(p => inline(p, 30)).join(', ')}`);
            if (op.deny?.length) parts.push(`deny ${op.deny.map(p => inline(p, 30)).join(', ')}`);
            if (op.clear?.length) parts.push(`inherit ${op.clear.map(p => inline(p, 30)).join(', ')}`);
            return `🔒 ${name(op.channel)} for ${name(op.target)}: ${parts.join('; ')}`;
        }
        case 'post_message':
            return `💬 Post in ${name(op.channel)}: ${name(inline(op.content, 300))}`;
        case 'edit_server': {
            const parts = [];
            if (op.name) parts.push(`rename to ${name(op.name)}`);
            if (op.system_channel) parts.push(`system channel ${name(op.system_channel)}`);
            if (op.afk_channel) parts.push(`AFK channel ${name(op.afk_channel)}`);
            if (op.afk_timeout) parts.push(`AFK timeout ${op.afk_timeout}s`);
            return `🏠 Server: ${parts.join(', ') || 'no changes'}`;
        }
        case 'create_role':
            return `🏷️ Create role ${name(op.name)}${op.color ? ` (${inline(op.color, 10)})` : ''}`;
        case 'edit_role': {
            const parts = [];
            if (op.name) parts.push(`rename to ${name(op.name)}`);
            if (op.color) parts.push(`colour ${inline(op.color, 10)}`);
            if (typeof op.hoist === 'boolean') parts.push(op.hoist ? 'show separately' : 'stop showing separately');
            if (typeof op.mentionable === 'boolean') parts.push(op.mentionable ? 'mentionable' : 'not mentionable');
            return `🏷️ Edit role ${name(op.role)}: ${parts.join(', ') || 'no changes'}`;
        }
        default:
            return `❓ ${inline(op?.action, 30) || 'unknown step'}`;
    }
}

/** The whole plan in words, which is what the approval prompt shows. */
function previewPlan(args) {
    const operations = Array.isArray(args?.operations) ? args.operations : [];
    const deletes = operations.filter(op => op?.action === 'delete_channel').length;
    const lines = [];
    if (args?.summary) lines.push(`**Plan:** ${inline(args.summary, 200)}`);
    lines.push(...operations.map((op, index) => `${index + 1}. ${describeStep(op)}`));
    if (deletes) lines.push(`⚠️ ${deletes} channel${deletes === 1 ? '' : 's'} will be deleted, with ${deletes === 1 ? 'its' : 'their'} messages. That cannot be undone.`);
    return lines.join('\n');
}

/**
 * Run an approved plan, top to bottom.
 *
 * A failed step does not stop the rest: most plans are independent changes,
 * and stopping halfway leaves a layout no more consistent than carrying on
 * does. What the model gets back is every step's outcome, so it can tell the
 * user exactly what is and is not done — and a step that named a channel a
 * failed step was meant to create fails too, saying so.
 */
async function applyLayout(args, message) {
    const invalid = validatePlan(args);
    if (invalid) return invalid;

    const { guild, member } = message;
    if (!guild || !member) return 'Nothing was changed: this only works in a server.';

    const who = message.author?.username || message.author?.tag || message.author?.id || 'someone';
    const ctx = {
        guild,
        member,
        channel: message.channel,
        created: [],
        reason: `AI layout change requested by ${who}`.slice(0, 512)
    };

    const results = [];
    let ok = 0;
    for (const [index, op] of args.operations.entries()) {
        const n = index + 1;
        try {
            const said = await STEPS[op.action](op, ctx);
            ok += 1;
            results.push(`${n}. ✅ ${said}`);
        } catch (err) {
            // A StepError is this code's own refusal; anything else is Discord's,
            // and "Missing Permissions" there means the bot's, not the user's.
            const why = err instanceof StepError
                ? err.message
                : /missing permissions/i.test(err.message)
                    ? 'the bot is missing the Discord permission for this (check its role and the channel\'s overwrites)'
                    : err.message;
            results.push(`${n}. ❌ ${describeStep(op).replace(/\*\*/g, '')} — ${why}`);
        }
    }

    const failed = results.length - ok;
    const heading = failed
        ? `${ok} of ${results.length} steps were applied; ${failed} failed. Tell the user which failed and why.`
        : `All ${results.length} steps were applied.`;
    return `${heading}\n${results.join('\n')}`;
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

function isPrivate(channel, guild) {
    const everyone = channel.permissionOverwrites?.cache?.get(guild.id);
    return Boolean(everyone?.deny?.has?.(PermissionFlagsBits.ViewChannel));
}

function describeChannel(channel, guild) {
    const flags = [];
    if (isPrivate(channel, guild)) flags.push('private');
    if (channel.nsfw) flags.push('age-restricted');
    if (channel.rateLimitPerUser) flags.push(`slowmode ${channel.rateLimitPerUser}s`);
    if (channel.parentId && channel.permissionsLocked === false) flags.push('permissions not synced');
    const topic = channel.topic ? ` — ${inline(channel.topic, 100)}` : '';
    return `#${channel.name} (${TYPE_LABELS[channel.type] || 'other'}, ${channel.id})${flags.length ? ` [${flags.join(', ')}]` : ''}${topic}`;
}

function describeOverwrites(channel, guild) {
    const lines = [];
    for (const overwrite of channel.permissionOverwrites?.cache?.values?.() || []) {
        const who = overwrite.id === guild.id
            ? '@everyone'
            : guild.roles.cache.get(overwrite.id)
                ? `@${guild.roles.cache.get(overwrite.id).name}`
                : `member ${overwrite.id}`;
        const allow = new PermissionsBitField(overwrite.allow).toArray();
        const deny = new PermissionsBitField(overwrite.deny).toArray();
        const parts = [];
        if (allow.length) parts.push(`allow ${allow.join(', ')}`);
        if (deny.length) parts.push(`deny ${deny.join(', ')}`);
        lines.push(`  ${who}: ${parts.join('; ') || 'nothing set'}`);
    }
    return lines.length ? lines.join('\n') : '  no overwrites — it inherits everything';
}

// Discord's sidebar order: text-like before voice-like, then by position.
function sidebarOrder(a, b) {
    const voice = channel => (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice ? 1 : 0);
    return voice(a) - voice(b) || (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0);
}

function reviewLayout(args, message) {
    const { guild } = message;
    if (!guild) return 'This only works in a server.';

    if (args?.channel) {
        let channel;
        try {
            channel = resolveChannel(guild, args.channel, []);
        } catch (err) {
            return `Could not look that up: ${err.message}.`;
        }
        const parent = channel.parentId ? guild.channels.cache.get(channel.parentId) : null;
        return [
            describeChannel(channel, guild),
            parent ? `In category "${parent.name}" (${parent.id})` : 'Not in a category',
            'Permission overwrites:',
            describeOverwrites(channel, guild)
        ].join('\n');
    }

    const all = [...guild.channels.cache.values()].filter(channel => !isThread(channel));
    const categories = all.filter(channel => channel.type === ChannelType.GuildCategory)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    const loose = all.filter(channel => channel.type !== ChannelType.GuildCategory && !channel.parentId).sort(sidebarOrder);

    const lines = [`Server "${guild.name}" (${guild.id}) — ${categories.length} categories, ${all.length - categories.length} channels.`];
    if (guild.systemChannelId) lines.push(`System messages go to <#${guild.systemChannelId}>.`);
    if (guild.afkChannelId) lines.push(`AFK channel: ${guild.afkChannelId}, after ${Math.round((guild.afkTimeout || 0) / 60)} min.`);

    let listed = 0;
    const push = line => { if (listed < MAX_REVIEW_CHANNELS) lines.push(line); listed += 1; };

    if (loose.length) {
        lines.push('', 'Not in a category:');
        for (const channel of loose) push(`  ${describeChannel(channel, guild)}`);
    }
    for (const category of categories) {
        lines.push('', `Category "${category.name}" (${category.id})${isPrivate(category, guild) ? ' [private]' : ''}:`);
        const children = all.filter(channel => channel.parentId === category.id).sort(sidebarOrder);
        if (!children.length) lines.push('  (empty)');
        for (const channel of children) push(`  ${describeChannel(channel, guild)}`);
    }
    if (listed > MAX_REVIEW_CHANNELS) lines.push(`… and ${listed - MAX_REVIEW_CHANNELS} more not listed.`);

    const roles = [...guild.roles.cache.values()]
        .filter(role => role.id !== guild.id)
        .sort((a, b) => b.position - a.position);
    lines.push('', `Roles, highest first (${roles.length}):`);
    lines.push(roles.slice(0, MAX_REVIEW_ROLES)
        .map(role => `@${role.name} (${role.id})${role.managed ? ' [integration]' : ''}`)
        .join(', ') || '(none besides @everyone)');
    if (roles.length > MAX_REVIEW_ROLES) lines.push(`… and ${roles.length - MAX_REVIEW_ROLES} more.`);

    lines.push('', 'Ask with a channel to see its permission overwrites.');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// As tools
// ---------------------------------------------------------------------------

const OPERATION_SCHEMA = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ACTIONS,
            description: 'What this step does.'
        },
        channel: {
            type: 'string',
            description: 'The channel or category the step acts on (edit_channel, delete_channel, set_permissions, '
                + 'post_message): its id, <#id> mention, or exact name. A name created earlier in this plan works.'
        },
        name: { type: 'string', maxLength: MAX_NAME_LENGTH, description: 'New name (create_*, edit_channel, edit_role, edit_server).' },
        type: {
            type: 'string',
            enum: Object.keys(CHANNEL_TYPES),
            description: 'create_channel only; defaults to text.'
        },
        category: {
            type: 'string',
            description: 'create_channel/edit_channel: the category to put it in, by id or name. "none" takes it out of one.'
        },
        topic: { type: 'string', maxLength: MAX_TOPIC_LENGTH, description: 'Channel topic; empty string clears it.' },
        nsfw: { type: 'boolean', description: 'Age-restricted or not.' },
        slowmode: { type: 'integer', minimum: 0, maximum: MAX_SLOWMODE_SECONDS, description: 'Seconds between messages per user; 0 turns it off.' },
        position: { type: 'integer', minimum: 0, description: 'Position among its siblings, 0 being the top.' },
        sync_permissions: { type: 'boolean', description: 'edit_channel: make its permissions match its category.' },
        target: {
            type: 'string',
            description: 'set_permissions: who the overwrite is for — "@everyone", a role name or id, or a member as <@id>.'
        },
        allow: { type: 'array', items: { type: 'string' }, description: 'set_permissions: permissions to grant, e.g. ["ViewChannel","SendMessages"].' },
        deny: { type: 'array', items: { type: 'string' }, description: 'set_permissions: permissions to deny.' },
        clear: { type: 'array', items: { type: 'string' }, description: 'set_permissions: permissions to set back to inherit.' },
        reset: { type: 'boolean', description: 'set_permissions: remove this target\'s overwrite entirely.' },
        content: { type: 'string', maxLength: MAX_MESSAGE_LENGTH, description: 'post_message: the message to post, as written.' },
        role: { type: 'string', description: 'edit_role: the role, by name or id.' },
        color: { type: 'string', description: 'create_role/edit_role: hex colour like #5865F2.' },
        hoist: { type: 'boolean', description: 'create_role/edit_role: show members separately in the member list.' },
        mentionable: { type: 'boolean', description: 'create_role/edit_role: anyone can @mention it.' },
        system_channel: { type: 'string', description: 'edit_server: text channel for join messages, or "none".' },
        afk_channel: { type: 'string', description: 'edit_server: voice channel idle members are moved to, or "none".' },
        afk_timeout: { type: 'integer', enum: AFK_TIMEOUTS, description: 'edit_server: seconds idle before moving to the AFK channel.' }
    },
    required: ['action']
};

/**
 * The layout tools for one turn, or [] for somebody who could not use them.
 *
 * Offered to members with Manage Channels, the permission the bulk of a layout
 * needs. The steps that need more — Manage Roles, Manage Server — are offered
 * in the same tool and refused at the step, which is better than a second tool
 * the model has to know to reach for.
 */
function buildLayoutTools(message, tool) {
    if (!message?.guild || !message.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return [];

    const review = tool({
        name: 'review_server_layout',
        description: 'Read this server\'s current layout: categories and channels in sidebar order with ids, types, '
            + 'topics and whether each is private, the roles, and the system/AFK channels. Pass a channel to see its '
            + 'permission overwrites. Call this before planning changes with apply_layout. Changes nothing.',
        properties: {
            channel: { type: 'string', description: 'Optional: one channel or category (id or name) to show in detail.' }
        },
        required: [],
        run: args => reviewLayout(args, message)
    });
    review.annotations = { readOnlyHint: true, destructiveHint: false };

    const apply = tool({
        name: 'apply_layout',
        description: 'Change this server: create, rename, move, reorder or delete categories and channels; set topics, '
            + 'slowmode and age restriction; set or remove permission overwrites; post a message in a channel; create '
            + 'or restyle roles (never their permissions); rename the server or set its system and AFK channels. '
            + `Put every change for one request in one plan of up to ${MAX_OPERATIONS} ordered operations — later `
            + 'steps can name channels earlier steps create. The user is shown the whole plan and asked to approve it; '
            + 'each step is then checked against their own permissions. Call review_server_layout first so the plan '
            + 'names channels that exist. Only delete a channel when the user explicitly asked for that.',
        properties: {
            summary: { type: 'string', maxLength: 300, description: 'One sentence saying what the plan does, shown to the user.' },
            operations: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_OPERATIONS,
                items: OPERATION_SCHEMA,
                description: 'The steps, run in order.'
            }
        },
        required: ['summary', 'operations'],
        confirm: true,
        destructive: true,
        run: args => applyLayout(args, message)
    });
    apply.preview = previewPlan;

    return [review, apply];
}

module.exports = {
    buildLayoutTools,
    applyLayout,
    reviewLayout,
    previewPlan,
    validatePlan,
    resolveChannel,
    MAX_OPERATIONS
};
