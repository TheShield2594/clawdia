'use strict';

// Shard identity, and the guild-to-shard affinity rule the session stores rely
// on (#732).
//
// ── The decision this module records ─────────────────────────────────────────
//
// #609 moved every piece of money-adjacent state out of process-local Maps and
// into Mongo. Four things were left behind, all of them live multiplayer rounds:
// crash lobbies (src/utils/crashLobby.js), heist and syndicate heist sessions,
// and the raid-mode join window. They stayed because a lobby is not a value — it
// is an object graph holding setInterval handles and component collectors bound
// to a specific message, none of which serialises.
//
// #732 asked whether that is safe under sharding, and the answer turns on one
// question: is a guild guaranteed to be handled by exactly one shard?
//
// It is, and not by convention — by Discord's gateway. Every guild's events are
// delivered to the shard `(guildId >> 22) % shardCount` and to no other, which
// is the same formula `shardIdForGuild` implements below. So:
//
//   - heist, syndicate heist and the raid join window are keyed by guildId, and
//     one guild's events only ever reach one shard;
//   - crash lobbies are keyed by channelId, and a channel belongs to exactly one
//     guild, so they inherit the same affinity.
//
// A second process therefore cannot produce a duplicate lobby for the same
// guild the way #609's framing suggested. What remains is narrower and was
// always true of a single process too: a restart mid-round abandons that round.
// Crash already answers that with `pendingCrashRefund`, reconciled at startup in
// src/events/ready.js.
//
// So this module is deliberately not a session-persistence layer. It is the
// scaffolding that makes affinity real: the identity a process has, the formula
// stated once, and an assertion the session stores call so a violation is loud
// rather than a silently duplicated round.
//
// ── What is NOT shard-safe, and is gated instead ─────────────────────────────
//
// Affinity solves guild-scoped state. It does nothing for singleton work, which
// must run in exactly one process no matter how many shards there are:
//
//   - the dashboard binds a TCP port, and N processes would fight over it;
//   - every cron job in src/services/scheduler would fire once per shard, and
//     jobRunner's overlap guard is process-local so it would not notice.
//
// Both are gated on `isPrimaryShard()` at their bootstrap site.

/** Discord's gateway routing rule. The one place it is written down. */
const GUILD_SHARD_SHIFT = 22n;

/**
 * The shard a guild's events are delivered to.
 *
 * `(guildId >> 22) % shardCount`, in BigInt because a snowflake does not fit in
 * a double — computing this in Number arithmetic silently rounds the low bits
 * away and lands on the wrong shard for a fraction of guilds.
 */
function shardIdForGuild(guildId, shardCount) {
    const count = Number(shardCount);
    if (!Number.isInteger(count) || count < 1) {
        throw new TypeError(`shardIdForGuild: shardCount must be a positive integer, got ${shardCount}`);
    }
    if (count === 1) return 0;
    let id;
    try {
        id = BigInt(guildId);
    } catch {
        throw new TypeError(`shardIdForGuild: guildId must be a snowflake, got ${guildId}`);
    }
    return Number((id >> GUILD_SHARD_SHIFT) % BigInt(count));
}

/**
 * How many shards this deployment runs. One when unsharded, which is the
 * default and makes every rule here a no-op rather than a special case.
 */
function shardCount(client = null) {
    if (client?.shard?.count) return client.shard.count;
    const fromEnv = Number(process.env.SHARD_COUNT);
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 1;
}

/**
 * Which shard this process is. Null when the client has no shard assignment
 * yet; 0 when unsharded.
 */
function shardId(client = null) {
    const ids = client?.shard?.ids;
    if (Array.isArray(ids) && ids.length) return ids[0];
    const fromEnv = Number(process.env.SHARD_ID);
    if (Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv;
    return 0;
}

/**
 * True in the one process that owns singleton work — the dashboard, the cron
 * scheduler, anything that must happen once per deployment rather than once per
 * shard. Shard 0, or the only process when unsharded.
 */
function isPrimaryShard(client = null) {
    return shardId(client) === 0;
}

/** True when this process is the shard Discord routes that guild to. */
function ownsGuild(guildId, client = null) {
    const count = shardCount(client);
    if (count === 1) return true;
    try {
        return shardIdForGuild(guildId, count) === shardId(client);
    } catch {
        // An unparseable id is not this shard's to claim, but it is also not a
        // reason to take the process down — the caller's assertion decides.
        return false;
    }
}

/**
 * Guard for process-local session state keyed by guild.
 *
 * The four multiplayer stores hold a round for one guild in memory, which is
 * only correct while that guild's events reach one process. This says so out
 * loud at the point the assumption is used, so a routing change shows up as a
 * logged violation on the round that broke it rather than as two lobbies.
 *
 * Warns rather than throws on purpose: a mid-round throw would strand players
 * in a lobby whose stakes are already debited, which is a worse outcome than
 * the duplicate this is warning about.
 *
 * @returns {boolean} true when the guild belongs to this shard.
 */
function assertGuildAffinity(guildId, label, client = null) {
    if (ownsGuild(guildId, client)) return true;

    // `ownsGuild` returns false for an id it cannot route as well as for one
    // that belongs elsewhere, so the destination has to be resolved separately —
    // and resolving it is exactly what throws on an unroutable id. Working it
    // out before the warning is built keeps the "warns, never throws" contract
    // true for both cases.
    let routesTo;
    try {
        routesTo = `shard ${shardIdForGuild(guildId, shardCount(client))}`;
    } catch {
        routesTo = 'no shard — it is not a snowflake';
    }

    console.warn(
        `[sharding] ${label}: guild ${guildId} is handled in shard ${shardId(client)} but routes to ` +
        `${routesTo}. Guild-scoped session state assumes one shard per guild — ` +
        `see src/utils/sharding.js.`
    );
    return false;
}

/** Prefix for log lines, so a multi-process tail can be read. */
function shardTag(client = null) {
    const count = shardCount(client);
    return count === 1 ? '' : `[shard ${shardId(client)}/${count}] `;
}

module.exports = {
    GUILD_SHARD_SHIFT,
    shardIdForGuild,
    shardCount,
    shardId,
    isPrimaryShard,
    ownsGuild,
    assertGuildAffinity,
    shardTag,
};
