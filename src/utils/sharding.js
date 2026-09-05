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

// ── What is neither, and is bounded instead ──────────────────────────────────
//
// A third category: process-local state that is neither guild-affine nor
// singleton work, but a *cache* — correct on every shard, merely capable of
// being out of date on the ones that did not do the writing (#934).
//
// `utils/guildSettingsCache.js` is the one that matters. It holds a guild's
// settings for 30 seconds on the hot read paths (messageCreate,
// interactionCreate), and it is invalidated by Mongoose middleware registered
// in models/Guild.js — middleware that runs in the process doing the write and
// nowhere else. So a dashboard save on shard 0 is invisible to shards 1..N
// until their own entry expires.
//
// The window is therefore bounded by the TTL and nothing else: at most 30
// seconds during which a message handled on another shard is judged against the
// settings that applied before the save. Nothing here moves coins or grants
// permission that a stale read could widen — the dashboard's own authorization
// is re-checked per request in dashboard/lib/permissions.js, not read from this
// cache — so the cost is a moderation rule or a welcome message lagging half a
// minute behind the admin who changed it.
//
// How reachable it is depends on the deployment, and there are three cases:
//
//   unsharded          the window is empty. One process, so the middleware that
//                      invalidates is always the one holding the cache.
//   two or more shards the window is real *now*. The dashboard is gated on
//                      `isPrimaryShard()` (above), so an admin's save always
//                      lands on shard 0 — and invalidates shard 0's entry and no
//                      other. Shards 1..N keep serving the pre-save settings
//                      until their own entry expires. The bot's own commands are
//                      the case that stays covered: a command writes on whatever
//                      shard is handling that guild, which is the shard holding
//                      the entry the middleware then drops.
//   dashboard split    wider still (#876). A dashboard in its own process shares
//                      middleware with no shard at all, so even a single-shard
//                      deployment gets the window, and a save invalidates
//                      nothing anywhere.
//
// Recorded here rather than fixed, because the fix costs more than the staleness
// does at this size. When it stops being acceptable, the two options are:
//
//   - shorten the TTL, which trades staleness for read load one-for-one; or
//   - add a Mongo-side invalidation bump — a monotonically increasing counter on
//     the guild document that the cached read compares against — which is one
//     extra round trip per read and removes the window entirely.

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
 * What to hand `ShardingManager` as its `totalShards` (#951).
 *
 * SHARD_COUNT pins a number. Anything else — unset, empty, a typo, a zero, a
 * negative, a float — falls through to `'auto'`, which asks the gateway how
 * many it wants. That fallback is deliberately not a throw: this is read by
 * the process an operator starts, and refusing to boot over a mistyped
 * *optional* variable trades a running deployment for a strict one.
 *
 * `'auto'` as the literal string because that is the value discord.js reads.
 * Returning the unparsed variable instead is the failure this exists to
 * prevent: the manager takes the string as a number and spawns NaN shards.
 *
 * Distinct from `shardCount()` below, which answers a different question — that
 * one is "how many shards are there", asked by an already-running child that
 * has a client; this one is "how many should be spawned", asked once by the
 * manager before any of them exist.
 *
 * @param {object} [env] the environment to read; injectable for the tests.
 * @returns {number|'auto'} a pinned positive integer, or the gateway's call.
 */
function resolveTotalShards(env = process.env) {
    const pinned = Number(env.SHARD_COUNT);
    if (Number.isInteger(pinned) && pinned > 0) return pinned;
    return 'auto';
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
 * Which process is responsible for work belonging to `guildId`.
 *
 * `ownsGuild` answers the routing question and nothing else, so it has no
 * opinion about work that has no guild — and the scheduler has some: a reminder
 * set in a DM carries `guildId: null`. That work still has to happen exactly
 * once, so it falls to the primary shard, the one process every deployment is
 * guaranteed to have.
 *
 * This is the predicate a per-guild scheduled job filters its work list with.
 * Unsharded it is constantly true for guild-scoped rows and true on the only
 * process for the rest, so it changes nothing until a second shard exists.
 */
function handlesGuild(guildId, client = null) {
    if (guildId === null || guildId === undefined || guildId === '') return isPrimaryShard(client);
    return ownsGuild(guildId, client);
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
    resolveTotalShards,
    shardCount,
    shardId,
    isPrimaryShard,
    ownsGuild,
    handlesGuild,
    assertGuildAffinity,
    shardTag,
};
