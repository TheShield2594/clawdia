'use strict';

/**
 * A stand-in ChatInputCommandInteraction for driving `src/commands/moderation/*`.
 *
 * #628: those sixteen files are the destructive surface — ban, kick, mute,
 * massban, lockdown, clear — and no test had ever invoked one of their
 * `execute()` functions. The directory reported non-zero line coverage, which
 * was module-level `SlashCommandBuilder` constants evaluating at import;
 * branches sat at zero. The role-hierarchy guard added in #588 was proven in
 * isolation and tied to its call sites by a source-text grep, which is exactly
 * the "fix that silently regresses" shape the issue warned about — a rename of
 * the helper keeps the grep passing.
 *
 * So this builds enough of a guild for the commands to run against: members
 * with role positions the hierarchy guard can compare, a member cache that
 * misses the way the real one does, and a ban/kick/timeout surface that records
 * what was called rather than performing it. `interaction.replies` is what
 * assertions about "what did the moderator actually see" read; `guild.actions`
 * is what "and what was actually done to the target" reads.
 */

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const GUILD_ID = 'guild-1';
const OWNER_ID = 'owner-1';
const BOT_ID   = 'bot-1';
const MOD_ID   = 'mod-1';

/** Discord's "no such member here" code, which resolveMember treats as absent. */
const UNKNOWN_MEMBER = 10007;

/**
 * A user, as the options resolver hands one over. `send` is the warning DM;
 * every command that sends one already swallows a rejection.
 */
function makeUser(id, { username = `user-${id}`, globalName = null, bot = false } = {}) {
    return { id, username, globalName, bot, send: jest.fn().mockResolvedValue(undefined) };
}

/**
 * A guild member with a role position the hierarchy guard can compare.
 *
 * `bannable` / `kickable` / `moderatable` are the *bot's* power over this
 * member and default to true, so a test that does not mention them is testing
 * the moderator's rank rather than the bot's.
 */
function makeMember(id, {
    position = 1,
    ownerId = OWNER_ID,
    bannable = true,
    kickable = true,
    moderatable = true,
    user = null,
} = {}) {
    const member = {
        id,
        user: user ?? makeUser(id),
        guild: { id: GUILD_ID, ownerId },
        bannable,
        kickable,
        moderatable,
        roles: { highest: { position, comparePositionTo: other => position - other.position } },
        kick: jest.fn().mockResolvedValue(undefined),
        timeout: jest.fn().mockResolvedValue(undefined),
    };
    return member;
}

/**
 * The guild the command acts on.
 *
 * `members.cache` holds only what a test puts in `cached`; everything else has
 * to come through `fetch`, which is the distinction resolveMember exists for.
 * `fetchable` is who the fetch can find, `fetchError` is what it throws instead
 * — the indeterminate case, which every ban-shaped command must refuse on.
 */
function makeGuild({
    ownerId = OWNER_ID,
    cached = [],
    fetchable = [],
    fetchError = null,
    bans = new Map(),
    banError = null,
} = {}) {
    const cache = new Map(cached.map(m => [m.id, m]));
    const fetchableById = new Map(fetchable.map(m => [m.id, m]));
    const actions = { banned: [], unbanned: [] };

    const fetchOne = async id => {
        if (fetchError) throw fetchError;
        const found = fetchableById.get(id);
        if (found) return found;
        const err = new Error('Unknown Member');
        err.code = UNKNOWN_MEMBER;
        throw err;
    };

    return {
        id: GUILD_ID,
        name: 'Guild',
        ownerId,
        actions,
        members: {
            cache,
            // discord.js overloads this: an id resolves one member, an object
            // with `user` resolves a batch and simply omits the ids it cannot
            // find — which is why a throw here says nothing about any of them.
            fetch: jest.fn(async query => {
                if (query && typeof query === 'object' && Array.isArray(query.user)) {
                    if (fetchError) throw fetchError;
                    return new Map(query.user
                        .filter(id => fetchableById.has(id))
                        .map(id => [id, fetchableById.get(id)]));
                }
                return fetchOne(query);
            }),
            ban: jest.fn(async (userOrId, options) => {
                if (banError) throw banError;
                actions.banned.push({ id: userOrId?.id ?? userOrId, options });
            }),
            unban: jest.fn(async (userId, reason) => {
                actions.unbanned.push({ id: userId, reason });
            }),
        },
        bans: {
            fetch: jest.fn(async id => {
                const found = bans.get(id);
                if (!found) throw new Error('Unknown Ban');
                return found;
            }),
        },
        channels: { cache: new Map() },
    };
}

/**
 * The interaction itself.
 *
 * Options are a flat bag read by name — the commands only ever ask for a value,
 * never for the option's metadata — plus `subcommand` for the three commands
 * built out of subcommands.
 */
function makeInteraction({
    options = {},
    subcommand = null,
    guild = makeGuild(),
    invoker = makeMember(MOD_ID, { position: 10 }),
    userId = MOD_ID,
    permissions = [PermissionFlagsBits.Administrator],
    channel = null,
    users = new Map(),
} = {}) {
    const replies = [];
    const record = payload => { replies.push(payload); return Promise.resolve(payload); };

    const interaction = {
        replies,
        replied: false,
        deferred: false,
        guild,
        member: invoker,
        user: makeUser(userId, { username: 'moderator' }),
        memberPermissions: new PermissionsBitField(permissions),
        channel: channel ?? {
            id: 'channel-1',
            isTextBased: () => true,
            bulkDelete: jest.fn().mockResolvedValue(new Map()),
            setRateLimitPerUser: jest.fn().mockResolvedValue(undefined),
        },
        client: {
            user: { id: BOT_ID },
            users: {
                fetch: jest.fn(async id => {
                    const found = users.get(id);
                    if (found) return found;
                    throw new Error('Unknown User');
                }),
            },
        },
        options: {
            getUser:       name => options[name] ?? null,
            getString:     name => options[name] ?? null,
            getInteger:    name => (options[name] === undefined ? null : options[name]),
            getBoolean:    name => (options[name] === undefined ? null : options[name]),
            getChannel:    name => options[name] ?? null,
            getSubcommand: () => subcommand,
        },
    };

    interaction.reply     = jest.fn(p => { interaction.replied = true; return record(p); });
    interaction.editReply = jest.fn(p => { interaction.replied = true; return record(p); });
    interaction.followUp  = jest.fn(record);
    interaction.deferReply = jest.fn(async () => { interaction.deferred = true; });

    return interaction;
}

/** The text of the last thing the moderator was shown, embed titles included. */
function lastReply(interaction) {
    const payload = interaction.replies[interaction.replies.length - 1];
    if (payload === undefined) return '';
    if (typeof payload === 'string') return payload;
    if (payload.content) return payload.content;
    const embed = payload.embeds?.[0];
    const data = embed?.data ?? embed ?? {};
    return [data.title, data.description, ...(data.fields ?? []).map(f => `${f.name}: ${f.value}`)]
        .filter(Boolean)
        .join('\n');
}

const command = name => require(`../../src/commands/moderation/${name}`);

module.exports = {
    makeUser,
    makeMember,
    makeGuild,
    makeInteraction,
    lastReply,
    command,
    GUILD_ID,
    OWNER_ID,
    BOT_ID,
    MOD_ID,
    UNKNOWN_MEMBER,
};
