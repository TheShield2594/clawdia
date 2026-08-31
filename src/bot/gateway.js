'use strict';

// The one seam between the dashboard and the gateway.
//
// The dashboard used to be handed the live `Client` and reach through it —
// `client.guilds.cache.get(id).channels.cache` and so on, across seventeen
// call sites. That made a process split and sharding structural impossibilities
// rather than deployment choices: a route holding a live `Guild` object cannot
// be moved to a process that has no gateway connection, and under sharding the
// cache it reads holds only the guilds Discord routed to this shard (#608).
//
// Every method here takes ids and returns plain data or performs one action.
// No discord.js object crosses this boundary, which is the property that lets
// the cache lookups below be replaced by a call to another process. Anything
// the dashboard needs from Discord gets a method here; anything it needs from
// the database it reads from Mongo itself.
//
// #876 took that the rest of the way: src/bot/remoteGateway.js implements the
// same surface over HTTP, so the dashboard can run in its own container with no
// gateway connection at all. Two consequences for this file.
//
// First, every method is async, including the ones that only read a cache. A
// route cannot be written against a facade whose methods are synchronous here
// and asynchronous over the wire — that difference is the whole bug, and it
// would only appear in the split deployment. So the local implementation pays
// a microtask to have one shape.
//
// Second, the method list is not this file's alone: src/bot/gatewayProtocol.js
// owns it, and the assertion at the bottom of `createBotGateway` holds this
// implementation to it. A method added here and not there is one the dashboard
// cannot call once it is out of process.

const { PermissionFlagsBits } = require('discord.js');
const { GATEWAY_METHODS, GATEWAY_METHOD_SET } = require('./gatewayProtocol');

// Discord channel type numbers, named so routes filter by meaning.
const CHANNEL_TYPES = {
    TEXT: 0,
    VOICE: 2,
    CATEGORY: 4,
    STAGE: 13,
};

const AVATAR_OPTS = { size: 32, extension: 'webp' };

function plainGuild(guild) {
    return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        ownerId: guild.ownerId,
        memberCount: guild.memberCount,
    };
}

function plainChannel(channel) {
    return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId ?? null,
    };
}

function plainRole(role) {
    return {
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed === true,
    };
}

function plainUser(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.globalName || user.username,
        tag: user.tag,
        avatarUrl: user.displayAvatarURL(AVATAR_OPTS),
    };
}

/**
 * Build the facade over a live client.
 *
 * Reads return `null` when the bot is not in the guild, which is the same
 * "no such guild here" the routes already answered with a 404. Actions that
 * Discord itself can refuse throw, so a route can tell "we do not have that
 * guild" apart from "Discord would not let us do that".
 *
 * @param {import('discord.js').Client} client
 */
function createBotGateway(client) {
    const guildOf = guildId => client.guilds.cache.get(guildId) || null;

    const gateway = {
        /** Is the bot in this guild? The check every permission gate makes. */
        async hasGuild(guildId) {
            return client.guilds.cache.has(guildId);
        },

        /**
         * The same question for a list, answered in one call.
         *
         * Three callers ask it of every guild in a user's OAuth guild list at
         * once — the guild picker, the access middleware, and /health. In this
         * process that is a cache lookup per id and the shape does not matter;
         * across the boundary (src/bot/remoteGateway.js) a per-id method would
         * be one HTTP request per guild the user is in, on every page load. So
         * the batch is the method, and the singular one stays for the routes
         * that genuinely have a single id.
         *
         * @returns {Promise<Record<string, boolean>>} keyed by the ids asked
         *   for, so a caller cannot silently read a missing id as false.
         */
        async hasGuilds(guildIds) {
            const present = {};
            for (const guildId of guildIds ?? []) {
                present[guildId] = client.guilds.cache.has(guildId);
            }
            return present;
        },

        /**
         * Does this user administer the guild *right now*?
         *
         * The dashboard's session carries the guild list Discord returned at
         * OAuth time and nothing refreshes it, so an admin who is demoted or
         * kicked keeps that snapshot's privileges for as long as the cookie
         * lives (#558). This is the second opinion: the member is fetched and
         * their effective guild permissions read, which is what Discord will
         * enforce anyway the moment the bot acts on their behalf.
         *
         * @returns {Promise<boolean|null>} true/false when Discord answered;
         *   null when it could not be asked — the bot is not in the guild, or
         *   the fetch failed for a reason other than the member being absent.
         *   Callers must not read null as a denial; see verifyLiveGuildAccess.
         */
        async canManageGuild(guildId, userId) {
            const guild = guildOf(guildId);
            if (!guild || !userId) return null;
            // Ownership is reported by the guild itself and outranks the
            // bitfield, so it never depends on a member fetch succeeding.
            if (guild.ownerId === userId) return true;

            let member;
            try {
                // `force` skips the member cache. A cached member is exactly the
                // stale snapshot this method exists to replace — the answer has
                // to come from Discord. The dashboard caches the result for a
                // minute (verifyLiveGuildAccess), so this is at most one request
                // per user per guild per minute.
                member = await guild.members.fetch({ user: userId, force: true });
            } catch (err) {
                // 10007 Unknown Member / 10013 Unknown User is the answer, not a
                // failure: they are not in this guild any more, so they may not
                // administer it. Anything else (a 5xx, a timeout, a missing
                // intent) means Discord did not say, and null is that.
                if (err?.code === 10007 || err?.code === 10013) return false;
                return null;
            }
            if (!member) return false;
            return member.permissions.has(PermissionFlagsBits.Administrator)
                || member.permissions.has(PermissionFlagsBits.ManageGuild);
        },

        async getGuild(guildId) {
            const guild = guildOf(guildId);
            return guild ? plainGuild(guild) : null;
        },

        /**
         * How much of Discord this instance actually serves: guilds the bot is
         * in, and the members across them.
         *
         * The landing page hardcoded "14,200 servers" and "2.1M commands / day"
         * as facts about the running instance (#704) — figures that on a
         * self-hosted deploy describe someone else's install, or none at all.
         * This is the honest version of that row.
         *
         * `memberCount` is Discord's own per-guild figure, summed. A member in
         * two of the instance's guilds is counted in both, which is why the
         * landing page labels it "members reached" rather than a headcount of
         * distinct people — the facade returns the number, not a claim about it.
         *
         * A guild whose `memberCount` Discord has not sent yet contributes 0
         * rather than making the whole sum NaN.
         *
         * @returns {{guilds: number, members: number}|null} null before the
         *   client has been ready, when the guild cache is empty because
         *   nothing has filled it yet rather than because the bot is in no
         *   guilds. Callers must render "we do not know" for that, not zero.
         */
        async reach() {
            if (!client?.readyAt) return null;
            const guilds = [...client.guilds.cache.values()];
            return {
                guilds: guilds.length,
                members: guilds.reduce((sum, guild) => sum + (Number(guild.memberCount) || 0), 0),
            };
        },

        /** @returns {Array<object>|null} null when the bot is not in the guild. */
        async listChannels(guildId) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            return [...guild.channels.cache.values()].map(plainChannel);
        },

        /** @returns {Array<object>|null} null when the bot is not in the guild. */
        async listRoles(guildId) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            return [...guild.roles.cache.values()].map(plainRole);
        },

        async hasChannel(guildId, channelId) {
            return guildOf(guildId)?.channels.cache.has(channelId) === true;
        },

        /**
         * Post an embed. `embed` is plain embed JSON rather than an
         * EmbedBuilder, so callers do not need discord.js to talk to this.
         *
         * @returns {Promise<{messageId: string}|null>} null when the guild or
         *   channel is not there; throws when Discord refuses the send.
         */
        async sendEmbed(guildId, channelId, embed) {
            const channel = guildOf(guildId)?.channels.cache.get(channelId);
            if (!channel) return null;
            const message = await channel.send({ embeds: [embed] });
            return { messageId: message.id };
        },

        /** React to a message with each emoji in order. Throws on refusal. */
        async addReactions(guildId, channelId, messageId, emojis) {
            const channel = guildOf(guildId)?.channels.cache.get(channelId);
            if (!channel) return false;
            const message = await channel.messages.fetch(messageId);
            for (const emoji of emojis) {
                await message.react(emoji);
            }
            return true;
        },

        /** Best-effort delete — a message already gone is not an error here. */
        async deleteMessage(guildId, channelId, messageId) {
            const channel = guildOf(guildId)?.channels.cache.get(channelId);
            if (!channel) return false;
            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) return false;
            return message.delete().then(() => true).catch(() => false);
        },

        /** @returns {Promise<Array<object>|null>} */
        async searchMembers(guildId, query, limit) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            const found = await guild.members.search({ query, limit });
            return [...found.values()].map(member => ({
                ...plainUser(member.user),
                displayName: member.displayName,
            }));
        },

        /**
         * Resolve ids to user cards. Unresolvable ids map to null rather than
         * being dropped, so a caller can tell "no such user" from "not asked".
         *
         * @returns {Promise<Record<string, object|null>>}
         */
        async resolveUsers(ids) {
            const resolved = {};
            await Promise.all(ids.map(async id => {
                try {
                    resolved[id] = plainUser(await client.users.fetch(id, { force: false }));
                } catch {
                    resolved[id] = null;
                }
            }));
            return resolved;
        },

        /**
         * @returns {Promise<Array<object>|null>} null when the bot is not in
         *   the guild; throws when Discord refuses the fetch, which is a
         *   missing permission rather than a missing guild.
         */
        async listBans(guildId, limit) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            const bans = await guild.bans.fetch({ limit });
            return [...bans.values()].map(ban => ({
                userId: ban.user.id,
                userTag: ban.user.tag,
                avatarUrl: ban.user.displayAvatarURL({ size: 32 }),
                reason: ban.reason || null,
            }));
        },

        /** Members whose timeout has not yet expired. @returns {Array|null} */
        async listActiveTimeouts(guildId, limit) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            const now = new Date();
            return [...guild.members.cache.values()]
                .filter(m => m.communicationDisabledUntil && m.communicationDisabledUntil > now)
                .slice(0, limit)
                .map(m => ({
                    userId: m.user.id,
                    userTag: m.user.tag,
                    avatarUrl: m.user.displayAvatarURL({ size: 32 }),
                    expires: m.communicationDisabledUntil?.toISOString() || null,
                }));
        },

        /** @returns {Promise<boolean|null>} null when the bot is not in the guild. */
        async unban(guildId, userId, reason) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            await guild.members.unban(userId, reason);
            return true;
        },

        /**
         * @returns {Promise<'ok'|'no-member'|null>} null when the bot is not in
         *   the guild, 'no-member' when the user has since left it.
         */
        async clearTimeout(guildId, userId, reason) {
            const guild = guildOf(guildId);
            if (!guild) return null;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return 'no-member';
            await member.timeout(null, reason);
            return 'ok';
        },

        // ── Bot-side work the dashboard triggers ────────────────────────────
        //
        // These reach Discord through a service rather than a cache, but they
        // are the same kind of thing: work that only a process holding a
        // gateway connection can do. Routing them through here too is what
        // keeps `client` out of the routes entirely.

        async sendDailyNews(guildId, profileId) {
            return require('../services/rssService').sendDailyNews(client, guildId, profileId);
        },

        async rescheduleBibleVerse(guildId) {
            return require('../services/dailyBibleService').rescheduleBibleVerse(client, guildId);
        },
    };

    assertImplementsProtocol(gateway, 'createBotGateway');
    return gateway;
}

/**
 * Holds an implementation to the method list in gatewayProtocol.
 *
 * Both implementations call this, which is what makes the list load-bearing
 * rather than documentation: a method added to one side and not the other
 * throws where it is built, at boot, rather than 404ing one dashboard route in
 * the split deployment and nowhere else.
 */
function assertImplementsProtocol(implementation, label) {
    const missing = GATEWAY_METHODS.filter(name => typeof implementation[name] !== 'function');
    const extra = Object.keys(implementation).filter(name => !GATEWAY_METHOD_SET.has(name));
    if (missing.length || extra.length) {
        throw new Error(
            `${label}: does not match src/bot/gatewayProtocol.js — ` +
            `${missing.length ? `missing ${missing.join(', ')}` : ''}` +
            `${missing.length && extra.length ? '; ' : ''}` +
            `${extra.length ? `not in the protocol: ${extra.join(', ')}` : ''}`
        );
    }
}

module.exports = { createBotGateway, assertImplementsProtocol, CHANNEL_TYPES };
