const mongoose = require('mongoose');

const state = {
    startedAt: new Date(),
    services: {},
    unhandledRejections: 0,
    uncaughtExceptions: 0,
};

/**
 * Record that a scheduled run was skipped because the previous run of the same
 * job was still executing. Deliberately does not touch lastSuccess/errorCount:
 * a skip is not a failure, but a job that skips every tick is overrunning its
 * schedule and an operator should be able to see that.
 */
function recordServiceSkip(serviceName) {
    const prev = state.services[serviceName] || { successCount: 0, errorCount: 0, skippedCount: 0 };
    state.services[serviceName] = {
        ...prev,
        skippedCount: (prev.skippedCount || 0) + 1,
        lastSkippedAt: new Date().toISOString(),
    };
}

function recordServiceRun(serviceName, { success, error = null, durationMs = null } = {}) {
    const prev = state.services[serviceName] || { successCount: 0, errorCount: 0 };
    state.services[serviceName] = {
        ...prev,
        lastRunAt: new Date().toISOString(),
        lastSuccess: success,
        lastError: error ? String(error) : null,
        lastDurationMs: durationMs,
        successCount: success ? prev.successCount + 1 : prev.successCount,
        errorCount: success ? prev.errorCount : prev.errorCount + 1,
    };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.detailed] Include per-service diagnostics, memory
 *   figures and raw error strings. Only for authenticated callers — the full
 *   payload leaks internal service names, failure messages (which can quote
 *   database errors or upstream API responses) and process memory to anyone who
 *   can reach the port.
 */
function getStatus({ detailed = true } = {}) {
    const mongoState = mongoose.connection.readyState;
    // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    const mongoLabels = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const mongoHealthy = mongoState === 1;

    const uptimeSeconds = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
    const mem = process.memoryUsage();

    const serviceStatuses = {};
    for (const [name, svc] of Object.entries(state.services)) {
        serviceStatuses[name] = {
            ...svc,
            healthy: svc.lastSuccess !== false,
        };
    }

    const allServicesHealthy = Object.values(serviceStatuses).every(s => s.healthy);
    const overall = mongoHealthy && allServicesHealthy ? 'healthy' : !mongoHealthy ? 'unhealthy' : 'degraded';

    // Enough for a container orchestrator's liveness probe, and nothing more.
    if (!detailed) {
        return { status: overall, uptime: uptimeSeconds };
    }

    return {
        status: overall,
        uptime: uptimeSeconds,
        startedAt: state.startedAt.toISOString(),
        mongo: {
            status: mongoLabels[mongoState] || 'unknown',
            healthy: mongoHealthy,
        },
        memory: {
            heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
            rssMb: Math.round(mem.rss / 1024 / 1024),
        },
        process: {
            unhandledRejections: state.unhandledRejections,
            uncaughtExceptions: state.uncaughtExceptions,
        },
        services: serviceStatuses,
    };
}

function incrementUnhandledRejections() { state.unhandledRejections++; }
function incrementUncaughtExceptions() { state.uncaughtExceptions++; }

/**
 * The HTTP status `/health` answers with for a given overall status.
 *
 * `degraded` used to answer 200 (#640). It is the state where mongo is up but a
 * scheduled service — RSS, raid detection, temp-ban sweeps, the daily verse — is
 * failing every run, which is exactly the half-broken bot an uptime monitor
 * exists to catch, and a 200 told every one of them it was fine. The monitors
 * that read the JSON body could have caught it; the ones that only look at the
 * status code, which is most of them, could not.
 *
 * So anything short of `healthy` is a non-200 now. This does not make a degraded
 * container restart: the compose healthchecks parse `status` out of the body and
 * fail only on `unhealthy`, deliberately, because restarting the process does not
 * fix a feed that is 404ing and a restart loop is worse than a degraded bot.
 *
 * @param {string} status `healthy`, `degraded` or `unhealthy`
 * @returns {number}
 */
function httpStatusFor(status) {
    return status === 'healthy' ? 200 : 503;
}

module.exports = {
    recordServiceRun,
    recordServiceSkip,
    getStatus,
    httpStatusFor,
    incrementUnhandledRejections,
    incrementUncaughtExceptions,
};
