const mongoose = require('mongoose');

const state = {
    startedAt: new Date(),
    services: {},
    unhandledRejections: 0,
    uncaughtExceptions: 0,
};

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

module.exports = { recordServiceRun, getStatus, incrementUnhandledRejections, incrementUncaughtExceptions };
