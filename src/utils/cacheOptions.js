const { Options } = require('discord.js');

/** The bot's own member: discord.js needs it for permission and hierarchy checks. */
function isClientMember(member) {
    return member.id === member.client.user.id;
}

/**
 * Members the periodic sweep leaves alone: the bot itself, and anyone currently
 * serving a timeout — the dashboard's active-sanctions view reads those out of
 * the member cache because Discord has no "list timed-out members" endpoint.
 *
 * This spares them from the hourly reclaim only, never from the size limit.
 * LimitedCollection drops the first entry its keepOverLimit call rejects and
 * inserts regardless of whether it found one, so a predicate that can hold back
 * an unbounded number of members turns the limit into a suggestion: 200 members
 * all serving timeouts at once would sit in a cache configured for 200 and grow
 * with every new arrival. The limit stays absolute, and a timed-out member can
 * be evicted under cache pressure like any other — which the sanctions view
 * already tolerates, since the member cache has never been a complete roster of
 * a guild large enough for Discord to withhold one.
 */
function keepMemberCached(member) {
    return isClientMember(member)
        || (member.communicationDisabledUntilTimestamp ?? 0) > Date.now();
}

/**
 * Out of the box discord.js caps only MessageManager (200 per channel) and
 * sweeps only archived threads: members, users and bans accumulate for the life
 * of the process. This container is capped at 1 GB (docker-compose.yml), and a
 * bot that has been up for weeks across a few busy guilds will walk into that
 * ceiling, so bound the growth explicitly.
 *
 * Everything limited here is re-fetchable on demand — nothing below is the only
 * copy of anything. Guild, channel, role and permission-overwrite caches are
 * deliberately left alone: discord.js does not support limiting them and warns
 * if you try.
 */
const makeCache = Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    GuildMemberManager: { maxSize: 200, keepOverLimit: isClientMember },
    UserManager: { maxSize: 500, keepOverLimit: user => user.id === user.client.user.id },
    // The presence intent is not requested, so nothing ever lands here.
    PresenceManager: 0,
    // Bans are only ever read through guild.bans.fetch(), which builds and
    // returns its own collection whether or not the cache keeps a copy.
    GuildBanManager: 0,
});

/** Limits cap the peak; sweepers give the memory back during idle periods. */
const sweepers = {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 600, lifetime: 900 },
    guildMembers: { interval: 3600, filter: () => member => !keepMemberCached(member) },
    users: { interval: 3600, filter: () => user => user.id !== user.client.user.id },
};

module.exports = { isClientMember, keepMemberCached, makeCache, sweepers };
