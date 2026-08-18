const FailedJob = require('../models/FailedJob');
const { recordServiceRun, recordServiceSkip } = require('../health');

// Jobs currently executing, keyed by service/jobName (plus guild, for per-guild
// jobs). node-cron fires on schedule whether or not the previous run finished,
// and several jobs here run every minute against the network and the shared
// Guild documents — two copies of the same job in flight can interleave a
// read-modify-write and lose the first run's changes. A tick that arrives while
// its own job is still running is dropped rather than queued: the next tick is
// at most a minute away, and the work is idempotent catch-up work.
const inFlight = new Set();

function inFlightKey(service, jobName, guildId) {
    return guildId ? `${service}/${jobName}#${guildId}` : `${service}/${jobName}`;
}

/**
 * Wraps a cron job function with overlap protection, error recording
 * (dead-letter queue) and health tracking.
 *
 * @param {string} service  - human-readable service name, e.g. "reminderService"
 * @param {string} jobName  - specific job name, e.g. "checkReminders"
 * @param {Function} fn     - async job function to run
 * @param {object} [opts]
 * @param {string}  [opts.guildId]      - guild this job is scoped to
 * @param {object}  [opts.payload]      - extra context stored on failure
 * @param {number}  [opts.maxAttempts]  - max DLQ retry count (default 3)
 * @returns {Promise<boolean>} false when the run was skipped because the same
 *   job (and guild, if scoped) was already in flight; true otherwise.
 */
async function runJob(service, jobName, fn, { guildId = null, payload = null, maxAttempts = 3 } = {}) {
    const key = inFlightKey(service, jobName, guildId);
    if (inFlight.has(key)) {
        recordServiceSkip(service);
        console.warn(`[JobRunner] ${key} still running from a previous tick — skipping this one.`);
        return false;
    }
    inFlight.add(key);

    const start = Date.now();
    try {
        await fn();
        recordServiceRun(service, { success: true, durationMs: Date.now() - start });
    } catch (error) {
        const durationMs = Date.now() - start;
        recordServiceRun(service, { success: false, error: error.message, durationMs });

        console.error(`[JobRunner] ${service}/${jobName} failed:`, error.message);

        try {
            await FailedJob.create({
                service,
                jobName,
                guildId,
                payload,
                errorMessage: error.message,
                errorStack: error.stack,
                maxAttempts,
                lastAttemptAt: new Date(),
            });
        } catch (dbErr) {
            // DLQ write failure must never crash the process
            console.error(`[JobRunner] Failed to write DLQ entry for ${service}/${jobName}:`, dbErr.message);
        }
    } finally {
        inFlight.delete(key);
    }

    return true;
}

/**
 * Retry a pending FailedJob by its _id.
 * Runs the supplied handler with the stored payload and updates the DLQ record.
 *
 * @param {string}   failedJobId  - FailedJob._id
 * @param {Function} handler      - async fn(payload) to call
 * @param {string}   resolvedBy   - userId or label for audit trail
 */
async function retryJob(failedJobId, handler, resolvedBy = 'system') {
    const record = await FailedJob.findById(failedJobId);
    if (!record) throw new Error('FailedJob not found');
    if (record.status === 'resolved') throw new Error('Job already resolved');
    if (record.status === 'exhausted') throw new Error('Job exhausted');

    record.attempts += 1;
    record.lastAttemptAt = new Date();
    record.status = 'retrying';
    await record.save();

    try {
        await handler(record.payload);
        record.status = 'resolved';
        record.resolvedAt = new Date();
        record.resolvedBy = resolvedBy;
    } catch (error) {
        record.errorMessage = error.message;
        record.errorStack = error.stack;
        record.status = record.attempts >= record.maxAttempts ? 'exhausted' : 'pending';
    }

    await record.save();
    return record;
}

module.exports = { runJob, retryJob };
