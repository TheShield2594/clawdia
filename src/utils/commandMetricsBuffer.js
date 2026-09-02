'use strict';

/**
 * In-memory buffer for per-command analytics (#895).
 *
 * `logCommandMetric` used to issue one `$push` with `$slice: -3000` against
 * `GuildAnalytics.commandUsage` per slash command, and `interactionCreate`
 * awaited it before replying. Two separate costs:
 *
 *   1. A capped `$push` is not an append. MongoDB rewrites the capped region of
 *      the array on every push, so the write is proportional to the cap, not to
 *      the one entry being added — and the cap is 3000. It was the largest
 *      per-interaction write the bot made.
 *   2. It sat on the critical path to the user's reply. Analytics are the one
 *      thing in the handler nobody is waiting for.
 *
 * Both go away by batching: entries accumulate here and one `bulkWrite` per
 * flush collapses a whole interval's commands into a single capped push per
 * guild. A guild doing 60 commands a minute goes from 60 capped pushes to two.
 *
 * What this trades away is durability, which is the right trade for telemetry:
 * a crash between flushes loses at most FLUSH_INTERVAL_MS of counts. The
 * shutdown path flushes (src/index.js), so a normal deploy loses nothing.
 *
 * Sharding needs nothing special. Each shard buffers and flushes its own
 * guilds' entries, and `$push` is additive, so two shards flushing the same
 * guild concurrently both land.
 */

const FLUSH_INTERVAL_MS = 30_000;

// Matches the model's documented cap. The `$slice` keeps the newest 3000
// entries whatever arrives, so this is the shape of the write, not a limit on
// what may be buffered.
const USAGE_CAP = 3000;

// Per-guild ceiling on buffered entries. Reached only by a guild issuing
// >30 commands/second sustained across a whole interval; past it the oldest
// buffered entries are dropped, because those are exactly the ones the
// `$slice` would discard anyway.
const MAX_ENTRIES_PER_GUILD = 1_000;

// Bounds the map itself the way guildSettingsCache bounds its cache. Only
// reachable while flushes are failing — a healthy process flushes at
// FLUSH_AT_ENTRIES long before it holds this many guilds — which is exactly the
// case it is for: a database outage must not turn buffered telemetry into an
// unbounded heap. A metric for a guild beyond this is dropped and counted.
const MAX_BUFFERED_GUILDS = 5_000;

// How many times the shutdown path will drain and re-check. The client is
// destroyed before this runs, so one more pass than the handlers still in
// flight can fill is plenty; the loop also stops early on no progress.
const SHUTDOWN_DRAIN_PASSES = 3;

// A burst should not wait out the interval. Crossing this flushes immediately
// instead — unless the last flush failed, in which case the interval is left to
// do the retrying. Otherwise every command during an outage would start its own
// write against a database that is already refusing them.
const FLUSH_AT_ENTRIES = 5_000;

const buffers = new Map(); // guildId -> entry[]

let timer = null;
let inFlight = null;
let pendingEntries = 0;
let droppedEntries = 0;
let flushes = 0;
let writtenEntries = 0;
let lastError = null;

// Required lazily so this module can be loaded (and unit-tested) without
// pulling in mongoose's model registry.
function getModel() {
    return require('../models/GuildAnalytics');
}

function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => { flushCommandMetrics().catch(() => {}); }, FLUSH_INTERVAL_MS);
    // Analytics must never be the reason the process stays alive. Node's test
    // and CLI paths both exit on an empty event loop, and an un-unref'd 30s
    // interval would hold them open.
    if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Buffer one command metric. Synchronous and never throws: this is called from
 * the interaction handler, where anything that can reject or block belongs
 * behind the reply, not in front of it.
 *
 * @param {string} guildId
 * @param {{command: string, channelId: string|null, hour: number,
 *          success: boolean, reason: string|null}} entry
 */
function recordCommandMetric(guildId, entry) {
    if (typeof guildId !== 'string' || !guildId) return;

    let queue = buffers.get(guildId);
    if (!queue) {
        if (buffers.size >= MAX_BUFFERED_GUILDS) {
            droppedEntries++;
            return;
        }
        queue = [];
        buffers.set(guildId, queue);
    }

    // Stamped here rather than left to the schema default, which would resolve
    // at flush time and put every entry in an interval within milliseconds of
    // each other — the dashboard buckets these by day and by hour.
    queue.push({ ...entry, createdAt: new Date() });
    pendingEntries++;

    if (queue.length > MAX_ENTRIES_PER_GUILD) {
        queue.splice(0, queue.length - MAX_ENTRIES_PER_GUILD);
        droppedEntries++;
        pendingEntries--;
    }

    ensureTimer();
    if (pendingEntries >= FLUSH_AT_ENTRIES && !inFlight && !lastError) {
        flushCommandMetrics().catch(() => {});
    }
}

// The op at index i is the i-th guild of the batch, and unappliedFrom() reads
// a failed write's indexes back through that correspondence — so the two have
// to iterate the batch the same way. Both go through this.
function guildsOf(batch) {
    return [...batch.keys()];
}

function buildOps(batch) {
    return [...batch].map(([guildId, entries]) => ({
        updateOne: {
            filter: { guildId },
            update: {
                $push: { commandUsage: { $each: entries, $slice: -USAGE_CAP } },
                $setOnInsert: { guildId },
            },
            upsert: true,
        },
    }));
}

/**
 * Write everything buffered so far. Safe to call at any time, including
 * concurrently — a second call while one is in flight awaits the first rather
 * than racing it.
 *
 * @returns {Promise<number>} entries written, 0 if there was nothing to write.
 */
function flushCommandMetrics() {
    if (inFlight) return inFlight;
    if (!buffers.size) return Promise.resolve(0);

    // Swapped out whole rather than drained per guild: metrics recorded while
    // the write is in flight belong to the next flush, and must not be lost by
    // a clear() after it resolves.
    const batch = new Map(buffers);
    const count = pendingEntries;
    buffers.clear();
    pendingEntries = 0;

    inFlight = getModel().bulkWrite(buildOps(batch), { ordered: false })
        .then(() => {
            flushes++;
            writtenEntries += count;
            // Cleared on success, so the burst flush above comes back once the
            // database does rather than staying disabled for the process.
            lastError = null;
            return count;
        })
        .catch(error => {
            lastError = error;
            // Put back what did not land, oldest first, so a transient outage
            // costs nothing more than a delay. The per-guild cap is re-applied
            // on the way in, which is what keeps a long outage from growing the
            // heap: the buffer stops at MAX_ENTRIES_PER_GUILD however many
            // flushes fail.
            requeue(unappliedFrom(batch, error));
            console.error('Command metric flush error:', error);
            return 0;
        })
        .finally(() => { inFlight = null; });

    return inFlight;
}

/**
 * The part of a failed batch that is safe to send again.
 *
 * `{ ordered: false }` means the server keeps going after a failed operation,
 * so a rejected bulk write can still have applied most of it. Re-sending the
 * whole batch would push those entries a second time and inflate the counts —
 * the mirror of the loss this buffer already accepts, and the one direction a
 * ratcheted `$slice` array cannot be corrected back from.
 *
 * A bulk write error names the operations that failed by their index in the ops
 * array, and buildOps() emits one op per guild in batch order, so those indexes
 * map back to guilds. Anything not named is applied and is dropped here.
 *
 * The exception is an error carrying no per-operation detail — a connection
 * that dropped, a timeout, a rejection before the write was sent. That is
 * either "nothing landed" or "it landed and the reply was lost", and nothing in
 * the response distinguishes them, so the whole batch goes back: a duplicate
 * count is the better failure of the two, and making it impossible needs an
 * idempotency key on every entry, which is a larger change than telemetry
 * warrants.
 *
 * @param {Map<string, object[]>} batch the batch that was sent.
 * @param {unknown} error whatever the driver rejected with.
 * @returns {Map<string, object[]>} the guilds whose entries must be retried.
 */
function unappliedFrom(batch, error) {
    const writeErrors = error?.writeErrors
        ?? error?.result?.writeErrors
        ?? error?.result?.result?.writeErrors;
    if (!Array.isArray(writeErrors) || !writeErrors.length) return batch;

    const guilds = guildsOf(batch);
    const unapplied = new Map();
    for (const writeError of writeErrors) {
        const index = writeError?.index ?? writeError?.err?.index;
        const guildId = guilds[index];
        if (guildId !== undefined) unapplied.set(guildId, batch.get(guildId));
    }
    return unapplied;
}

function requeue(batch) {
    for (const [guildId, entries] of batch) {
        const queue = buffers.get(guildId);
        if (!queue && buffers.size >= MAX_BUFFERED_GUILDS) {
            droppedEntries += entries.length;
            continue;
        }
        // Failed entries go back in front of anything recorded while the write
        // was in flight, so the array stays in time order.
        const merged = queue ? entries.concat(queue) : entries;
        const kept = merged.length > MAX_ENTRIES_PER_GUILD
            ? merged.slice(merged.length - MAX_ENTRIES_PER_GUILD)
            : merged;
        droppedEntries += merged.length - kept.length;
        buffers.set(guildId, kept);
    }
    // Recounted rather than adjusted: the trim above and the entries recorded
    // during the flush both move this, and a running total that drifts would
    // send FLUSH_AT_ENTRIES off in either direction for the rest of the process.
    pendingEntries = 0;
    for (const entries of buffers.values()) pendingEntries += entries.length;
}

/**
 * Stop the interval and write what is left. Called from the shutdown path so a
 * deploy does not drop the counts since the last flush.
 *
 * Drains rather than flushing once. A flush swaps the buffer out and leaves a
 * fresh one behind, and a command handler still finishing while that write is
 * open records into it — so a single flush would write the backlog and then
 * report whatever arrived behind it as lost. src/index.js destroys the Discord
 * client before calling this, which bounds how much can still arrive; the loop
 * bounds it again, and stops early when a pass makes no progress so a database
 * that is refusing writes ends the shutdown instead of spinning on a batch that
 * keeps being re-buffered.
 *
 * @returns {Promise<number>} entries written across every pass.
 */
async function stopCommandMetrics() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    let written = 0;
    for (let pass = 0; pass < SHUTDOWN_DRAIN_PASSES && buffers.size; pass++) {
        const drained = await flushCommandMetrics();
        written += drained;
        // A failed flush re-buffers; another pass would fail the same way.
        if (!drained) break;
    }

    // There is no next interval to pick up what is left — say so rather than
    // exiting quietly on lost telemetry.
    if (buffers.size) {
        console.error(`Command metric flush error: ${pendingEntries} buffered entr(ies) lost at shutdown`);
    }
    return written;
}

function getCommandMetricsStats() {
    return {
        guilds: buffers.size,
        pendingEntries,
        droppedEntries,
        flushes,
        writtenEntries,
        lastError: lastError ? lastError.message : null,
    };
}

/** Test seam: drop everything buffered and reset the counters. */
function resetCommandMetrics() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    buffers.clear();
    inFlight = null;
    pendingEntries = 0;
    droppedEntries = 0;
    flushes = 0;
    writtenEntries = 0;
    lastError = null;
}

module.exports = {
    recordCommandMetric,
    flushCommandMetrics,
    stopCommandMetrics,
    getCommandMetricsStats,
    resetCommandMetrics,
    FLUSH_INTERVAL_MS,
    USAGE_CAP,
    MAX_ENTRIES_PER_GUILD,
    MAX_BUFFERED_GUILDS,
};
