const FailedJob = require('../models/FailedJob');
const { recordServiceRun } = require('../health');

/**
 * Wraps a cron job function with error recording (dead-letter queue) and health tracking.
 *
 * @param {string} service  - human-readable service name, e.g. "reminderService"
 * @param {string} jobName  - specific job name, e.g. "checkReminders"
 * @param {Function} fn     - async job function to run
 * @param {object} [opts]
 * @param {string}  [opts.guildId]      - guild this job is scoped to
 * @param {object}  [opts.payload]      - extra context stored on failure
 * @param {number}  [opts.maxAttempts]  - max DLQ retry count (default 3)
 */
async function runJob(service, jobName, fn, { guildId = null, payload = null, maxAttempts = 3 } = {}) {
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
    }
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
