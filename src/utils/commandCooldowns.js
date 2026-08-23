'use strict';

/**
 * Where a slash command's cooldown lives.
 *
 * It used to live in exactly one place: a `Collection` on the client, with one
 * `setTimeout` per entry to evict it (#621). Two things follow from that, and
 * both are wrong for the long cooldowns:
 *
 *   - A restart clears every cooldown. A deploy in the middle of a six-hour
 *     `/heist` window hands that window back to everyone holding it.
 *   - A six-hour cooldown parks a six-hour timer. Thousands of live timers whose
 *     only job is to delete a map entry, none of which will ever fire on a
 *     process that restarts daily.
 *
 * So the store is split by how long the cooldown is:
 *
 *   under 15 minutes   in memory. A restart handing back a 5-second cooldown
 *                      costs nothing, and a database round trip on every
 *                      interaction to enforce it would cost a great deal.
 *   15 minutes or more persisted on the User document, in `commandCooldowns`.
 *                      Memory is still read first — it is written on every use,
 *                      so it answers without a query for the whole life of the
 *                      process — and Mongo is consulted only on a miss, which
 *                      is what a restart looks like from here.
 *
 * The in-memory half no longer schedules anything. Entries expire by being
 * compared against the clock when they are read, and a periodic sweep drops the
 * ones nobody comes back for. One interval for the whole process replaces one
 * timer per user per command.
 *
 * None of this is the enforcement boundary for money. Every command that pays
 * out still claims its own window atomically in Mongo (`lastWork`, `lastDaily`,
 * `lastCrime`, …) inside the update filter — see tests/economyCooldownClaims.js.
 * This is the pre-check that answers "you are on cooldown" without making the
 * user wait for that write to be attempted and rejected.
 */

const User = require('../models/User');

// Above this, a cooldown outlives a deploy often enough that losing it is a
// real effect a user can notice and exploit; below it, it does not.
const PERSIST_THRESHOLD_MS = 15 * 60 * 1000;

// The in-memory half is only ever a cache of "when did this user last run this",
// so an unbounded map of expired entries is the only leak available to it.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// The in-memory half is keyed by guild as well as by bucket, because the
// persisted half cannot be anything else: `commandCooldowns` lives on the User
// document, which is per (userId, guildId). Keying only by command name — which
// is what the map used to do — meant a user's `/daily` pre-check was shared
// across every guild they were in, while the atomic claim the command itself
// makes (`lastDaily` on that guild's User document) was not. The two halves now
// agree with each other and with what is actually enforced.
function keyFor(bucket, guildId) {
    return guildId ? `${guildId}:${bucket}` : bucket;
}

function bucketFor(cooldowns, bucket) {
    let timestamps = cooldowns.get(bucket);
    if (!timestamps) {
        timestamps = new Map();
        cooldowns.set(bucket, timestamps);
    }
    return timestamps;
}

/**
 * The moment `bucket` stops being on cooldown for this user, or 0 if it is not.
 *
 * `cooldownMs` is passed in rather than stored because a guild's
 * `cooldownOverrides` can change the length between two uses — the stored value
 * is the start of the window, and the length is always the current one.
 */
async function expiresAt(client, { bucket, userId, guildId, cooldownMs }) {
    if (cooldownMs <= 0) return 0;

    const now = Date.now();
    const timestamps = bucketFor(client.cooldowns, keyFor(bucket, guildId));

    const cached = timestamps.get(userId);
    if (cached !== undefined) {
        const expiry = cached + cooldownMs;
        // Lazy expiry: reading a stale entry is what deletes it, so no timer has
        // to exist to do it.
        if (expiry > now) return expiry;
        timestamps.delete(userId);
        return 0;
    }

    if (cooldownMs < PERSIST_THRESHOLD_MS || !guildId) return 0;

    // A memory miss on a long cooldown is a restart. This is the only query the
    // path makes, and only until the entry is written back below.
    const startedAt = await readPersisted(bucket, userId, guildId);
    if (!startedAt) return 0;

    const expiry = startedAt + cooldownMs;
    if (expiry <= now) return 0;

    timestamps.set(userId, startedAt);
    return expiry;
}

/**
 * Records that the user has just used `bucket`, so the next call is refused
 * until the window is out.
 *
 * The persisted write is awaited rather than fired and forgotten: a cooldown
 * that is only in memory is the bug this exists to fix, and the caller is about
 * to run the command either way.
 */
async function claim(client, { bucket, userId, guildId, cooldownMs }) {
    if (cooldownMs <= 0) return;

    const now = Date.now();
    bucketFor(client.cooldowns, keyFor(bucket, guildId)).set(userId, now);

    if (cooldownMs < PERSIST_THRESHOLD_MS || !guildId) return;

    await writePersisted(bucket, userId, guildId, new Date(now)).catch(err => {
        // The in-memory entry already holds for this process, so a failed write
        // costs the cooldown only if the process also restarts before it ends.
        // Refusing the command over it would be the worse trade.
        console.error(`[cooldown] could not persist ${bucket} for ${userId}:`, err.message);
    });
}

async function readPersisted(bucket, userId, guildId) {
    try {
        const doc = await User.findOne(
            { userId, guildId },
            { [`commandCooldowns.${bucket}`]: 1 },
        ).lean();
        const at = doc?.commandCooldowns?.[bucket];
        return at ? new Date(at).getTime() : 0;
    } catch (err) {
        // Answering "not on cooldown" is the safe failure: the command's own
        // atomic claim is what actually guards the payout.
        console.error(`[cooldown] could not read ${bucket} for ${userId}:`, err.message);
        return 0;
    }
}

function writePersisted(bucket, userId, guildId, at) {
    // `$set` on one Map key, never a read-modify-write of the whole map — two
    // long-cooldown commands used in the same second must not erase each other.
    return User.updateOne(
        { userId, guildId },
        { $set: { [`commandCooldowns.${bucket}`]: at } },
        { upsert: true },
    );
}

/**
 * Drops entries no live cooldown could still be using.
 *
 * `maxCooldownMs` is the longest window any command could have claimed; an
 * entry older than that cannot be holding anything back whatever bucket it is
 * in, which is what lets one sweep cover every bucket without knowing their
 * lengths. Returns the number of entries dropped.
 */
function sweep(cooldowns, maxCooldownMs = 48 * 60 * 60 * 1000, now = Date.now()) {
    let dropped = 0;
    for (const [bucket, timestamps] of cooldowns) {
        for (const [userId, startedAt] of timestamps) {
            if (now - startedAt > maxCooldownMs) {
                timestamps.delete(userId);
                dropped++;
            }
        }
        if (!timestamps.size) cooldowns.delete(bucket);
    }
    return dropped;
}

/**
 * Starts the sweep. Unref'd — this is housekeeping, and a process with nothing
 * else to do should be allowed to exit rather than being held open by it.
 */
function startCooldownSweeper(client, intervalMs = SWEEP_INTERVAL_MS) {
    const timer = setInterval(() => sweep(client.cooldowns), intervalMs);
    timer.unref?.();
    return timer;
}

module.exports = {
    expiresAt,
    claim,
    sweep,
    startCooldownSweeper,
    PERSIST_THRESHOLD_MS,
};
