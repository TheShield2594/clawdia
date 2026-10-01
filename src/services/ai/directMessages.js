'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../../utils/guildSettingsCache');

/**
 * Talking to the AI in a direct message.
 *
 * Everything the AI path reads is a server's: the provider and its key, the
 * MCP connections, the memories, the knowledge base, the monthly budget. A DM
 * has no server, so it borrows one — the operator's "home" server, named in
 * AI_DM_GUILD_ID — and is answered exactly as a message there would be, with
 * that server's settings, that member's memories and that server's budget.
 *
 * Who may: members of the home server with Manage Server, checked on every
 * message. That is the same bar a scheduled task's DM delivery holds to, and
 * for the same reason — a DM conversation runs on the server's connections and
 * money with nobody else in the room to see what it is doing. Anyone else gets
 * no answer at all, rather than a reply that confirms the bot listens to DMs.
 *
 * The operator names the server, never a guild setting: a guild admin who could
 * switch DMs on would be choosing to spend the bot's attention on every
 * stranger who DMs it, and two servers both claiming DMs would leave the bot
 * guessing whose settings a message belongs to.
 */

function homeGuildId() {
    const raw = typeof process.env.AI_DM_GUILD_ID === 'string' ? process.env.AI_DM_GUILD_ID.trim() : '';
    return /^\d{5,25}$/.test(raw) ? raw : null;
}

/**
 * The server a DM is answered as, and the member sending it — or null, with
 * the reason logged, when this DM is not one to answer.
 *
 * @returns {Promise<?{guild: object, member: object, settings: object}>}
 */
async function resolveDmContext(message, client) {
    const guildId = homeGuildId();
    if (!guildId) return null;

    // DMs arrive on shard 0. A home server on another shard is not in this
    // process's cache, and there is no member to check permissions against.
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) {
        console.warn(`[AI:dm] AI_DM_GUILD_ID ${guildId} is not a server this process can see; ignoring a DM`);
        return null;
    }

    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return null;

    const settings = await getGuildSettings(guildId);
    if (!settings?.ai?.enabled) return null;

    return { guild, member, settings };
}

/**
 * The DM, seen by the chat transport as a message in the home server.
 *
 * Only `guild` and `member` change: everything that reads "which server" or
 * "with what permissions" gets the home server's answer, and everything that
 * talks back — the channel, the reply, the typing indicator, the approval
 * buttons — still goes to the DM. Methods are bound to the real message, so a
 * `reply()` is a reply in the DM, made by discord.js with the message's real
 * (absent) guild.
 */
function asHomeMessage(message, guild, member) {
    return new Proxy(message, {
        get(target, prop) {
            if (prop === 'guild') return guild;
            if (prop === 'member') return member;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

/** Whether a message arrived in a direct message rather than a server channel. */
function isDirectMessage(message) {
    return !message.guild && Boolean(message.channel?.isDMBased?.());
}

module.exports = { homeGuildId, resolveDmContext, asHomeMessage, isDirectMessage };
