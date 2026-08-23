'use strict';

/**
 * Serialises work that reads, mutates and saves one User document.
 *
 * The message pipeline loads the author's document once and hands the same
 * object through four services — `handleLeveling` applies XP, `ensureQuests`
 * assigns, `onMessage` and `onStreakUpdate` advance progress, `checkAndAward`
 * grants achievements — and only then saves it (#617). That is the right shape:
 * one read and one write per message instead of four of each. What it is not is
 * concurrency-safe. Two messages from the same user a few hundred milliseconds
 * apart both read the pre-message document and both `save()` it, and `save()`
 * writes every modified path as an absolute `$set` — so the second write puts
 * back the XP, the message counter and the quest progress as they were before
 * the first message, and one message's worth of everything disappears.
 *
 * Coins already survive this: `saveWithBalanceDelta` folds `balance` out of the
 * save and re-applies it as an `$inc` (src/utils/balanceDelta.js). Nothing else
 * on the document can be expressed that way — a level threshold crossing, a
 * streak, a quest's completion flag are all decisions made from the value that
 * was read, not increments — so the fix for those is to stop the two flows
 * overlapping at all.
 *
 * This lock is in-process, and that is sufficient *here* specifically because
 * of what it guards. A guild's gateway events all arrive on one shard, so every
 * message from a user in a guild is handled by one process, in one event loop.
 * The Mongo-backed lease in src/utils/activeGameLock.js is the right tool when a
 * flow can also be started from the dashboard or a scheduled job; paying two
 * round trips per message to reach across a boundary nothing crosses is not.
 *
 * A holder that never settles would block that user forever, so the wait is
 * bounded: past `timeoutMs` the next caller stops waiting and runs anyway. That
 * trades the lost update this exists to prevent — once, on a pipeline that has
 * already hung for seconds — against a user whose messages stop counting until
 * the bot restarts. The first is recoverable; the second is not.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

// key -> promise for the tail of that key's queue. Deleted when the queue
// drains, so this holds one entry per user with work in flight, not one per
// user the bot has ever seen.
const chains = new Map();

function timeoutAfter(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/**
 * Runs `fn` with nothing else that took the same `key` running alongside it.
 *
 * Returns whatever `fn` returns, and propagates what it throws — the queue is
 * unaffected either way, so one failing message cannot wedge the next.
 */
async function withUserLock(key, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const previous = chains.get(key);

    let release;
    const mine = new Promise(resolve => { release = resolve; });
    chains.set(key, mine);

    // Never awaits the previous body's *result* — only its settling — so a
    // rejection upstream is not rethrown here as this caller's failure.
    if (previous) await Promise.race([previous, timeoutAfter(timeoutMs)]);

    try {
        return await fn();
    } finally {
        release();
        // Only the tail clears the map. A later caller has already replaced the
        // entry with its own promise and is still running.
        if (chains.get(key) === mine) chains.delete(key);
    }
}

/** How many keys have work in flight. Exported for the tests and the leak check. */
function pendingLocks() {
    return chains.size;
}

module.exports = { withUserLock, pendingLocks, DEFAULT_TIMEOUT_MS };
