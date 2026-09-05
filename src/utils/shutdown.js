'use strict';

// The graceful shutdown sequence, lifted out of src/index.js so it can be
// tested (#951).
//
// It lived inside the entrypoint, which is on the `neverExecuted` list in
// coverage-floors.json — so the one path that runs on every single deploy was
// the one path nothing exercised. The CI image job boots the container, which
// would catch a shutdown that failed to load; it does not catch a shutdown that
// closes things in the wrong order, because nothing there ever sends the
// signal.
//
// ── The order, and why it is that order ──────────────────────────────────────
//
// Each step is here because the step before it has to have finished:
//
//   1. stopScheduler()        no new cron job may start while the rest of this
//                             runs — a job that begins here would be reaching
//                             for a database connection step 4 is about to
//                             close.
//   2. client.destroy()       close the gateway. After this no new interaction
//                             can arrive, which is what makes step 3 a drain
//                             rather than a race.
//   3. stopCommandMetrics()   command counts are buffered in memory between 30s
//                             flushes (#895), so a deploy would otherwise drop
//                             up to an interval of them on every restart. It is
//                             after the gateway closes so that no command can
//                             arrive behind the write and be reported as lost,
//                             and before step 4 because it writes to Mongo.
//   4. connection.close()     last, because 3 needs it open.
//
// ── Why the exit is unconditional ────────────────────────────────────────────
//
// Every failure path still reaches `exit(0)`. The container is going away
// either way: the signal has already been sent, and a process that answers
// SIGTERM by throwing does not stay alive — it waits out Docker's grace period
// and is killed, which is the slow version of the same outcome with a worse
// log. So a step that throws is logged and the sequence continues.
//
// `stopScheduler` is guarded separately for that reason. In the entrypoint it
// sat outside the try, so a throw from it propagated out of the signal handler
// as an unhandled rejection and the gateway and the database were never closed
// at all — the buffered metrics went with them. It is the first step, so it is
// also the step with the most left to lose.

/**
 * Close everything this process holds open, in order, and exit.
 *
 * Collaborators are injected. `stopCommandMetrics` defaults to a lazy require,
 * matching how the entrypoint pulled it in — at shutdown rather than at module
 * load, so that requiring this file (which the tests do) does not drag that
 * graph in behind it.
 *
 * `stopScheduler` has no default and must be passed. It is not an oversight:
 * `services` sits above `utils` in the layer order this tree is linted against
 * (see LAYERS in eslint.config.js), so this module may not reach for the
 * scheduler even lazily. The entrypoint is above both and owns that wiring —
 * which is the right place for it anyway. A caller that forgets is caught by
 * the guard below and logged rather than taking the shutdown down.
 *
 * @param {string} signal the signal that started this, for the log line.
 * @param {object} deps
 * @param {{destroy: function(): Promise<void>}} deps.client the Discord client.
 * @param {{close: function(): Promise<void>}} deps.connection the mongoose connection.
 * @param {function(): void} deps.stopScheduler required; see above.
 * @param {function(): Promise<void>} [deps.stopCommandMetrics]
 * @param {function(number): void} [deps.exit]
 * @param {function(...*): void} [deps.log]
 * @param {function(...*): void} [deps.logError]
 * @returns {Promise<void>} resolves once `exit` has been called.
 */
async function runShutdown(signal, {
    client,
    connection,
    stopScheduler,
    stopCommandMetrics = () => require('./commandMetricsBuffer').stopCommandMetrics(),
    exit = code => process.exit(code),
    log = console.log,
    logError = console.error,
} = {}) {
    log(`[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);

    // Its own try: see the note above on why a throw here must not take the
    // gateway and the database down with it.
    try {
        stopScheduler();
    } catch (err) {
        logError('[SHUTDOWN] Error stopping the scheduler:', err);
    }

    try {
        await client.destroy();
        await stopCommandMetrics();
        await connection.close();
        log('[SHUTDOWN] Clean exit.');
    } catch (err) {
        logError('[SHUTDOWN] Error during shutdown:', err);
    }

    exit(0);
}

module.exports = { runShutdown };
