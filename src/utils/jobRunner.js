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

function inFlightKey(service, jobName, guildId, scope) {
    const suffix = [guildId, scope].filter(Boolean).join(':');
    return suffix ? `${service}/${jobName}#${suffix}` : `${service}/${jobName}`;
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
 * @param {string}  [opts.scope]        - further narrows the overlap guard, for
 *   work scheduled per entity rather than per tick. A poll expiry fires once
 *   for one message and is never retried by a later tick, so two polls closing
 *   in the same second must not have the second dropped as an overlap.
 * @param {object}  [opts.payload]      - extra context stored on failure
 * @param {number}  [opts.maxAttempts]  - max DLQ retry count (default 3)
 * @returns {Promise<boolean>} false when the run was skipped because the same
 *   job (and guild, if scoped) was already in flight; true otherwise.
 */
async function runJob(service, jobName, fn, { guildId = null, scope = null, payload = null, maxAttempts = 3 } = {}) {
    const key = inFlightKey(service, jobName, guildId, scope);
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
 * The attempt is *claimed* rather than merely marked. Reading the record,
 * deciding it is retriable and then saving `retrying` is a check-then-act with a
 * window in it: two operators running the replay script at once both read a
 * pending record, both pass the guard, and both call the handler — which for an
 * owed payout is a second `$inc` or a second inventory grant. Since the handler
 * is what moves the money, that window has to be closed before it runs, not
 * after.
 *
 * The claim is a compare-and-set on `attempts`, which only ever increases: both
 * runs read the same value, both try to advance it, and the loser's filter no
 * longer matches. No extra field, and no lease to expire.
 *
 * A record left `retrying` by a run that died is still claimable — its
 * `attempts` is whatever that run left behind, so the next CAS against it
 * succeeds. Excluding `retrying` outright would close the race by stranding
 * those forever instead.
 *
 * @param {string}   failedJobId  - FailedJob._id
 * @param {Function} handler      - async fn(payload) to call
 * @param {string}   resolvedBy   - userId or label for audit trail
 */
async function retryJob(failedJobId, handler, resolvedBy = 'system') {
    const found = await FailedJob.findById(failedJobId);
    if (!found) throw new Error('FailedJob not found');
    if (found.status === 'resolved') throw new Error('Job already resolved');
    if (found.status === 'exhausted') throw new Error('Job exhausted');

    const record = await FailedJob.findOneAndUpdate(
        { _id: failedJobId, status: { $in: ['pending', 'retrying'] }, attempts: found.attempts },
        { $inc: { attempts: 1 }, $set: { status: 'retrying', lastAttemptAt: new Date() } },
        { new: true },
    );
    // Someone else advanced this record between the read above and the claim:
    // another replay run has it, or resolved it. Either way it is not ours.
    if (!record) throw new Error('Job is already being retried by another run');

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
