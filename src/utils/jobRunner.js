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

// How long an in-flight retry's claim on a dead-letter record is honoured.
//
// A lease rather than a flag, because `status: 'retrying'` cannot distinguish a
// replay that is running from one whose process died holding the record. Reading
// it as "running" strands the record forever; reading it as "dead" runs the
// handler a second time, which for an owed payout is a second credit. The
// timestamp is what tells them apart.
//
// Five minutes is far longer than any handler here takes — a replayed payout is
// a single write — so a live claim is never mistaken for a dead one in practice,
// and a genuinely dead one is recoverable within the window.
const RETRY_LEASE_MS = 5 * 60 * 1000;

/**
 * Filter fragment matching dead-letter records that are free to claim: retriable
 * status, and no lease or an expired one.
 *
 * Exported so a caller listing work to retry selects on the same terms the claim
 * in `retryJob` enforces. Listing records it will then be refused only produces
 * noise an operator has to learn to ignore.
 *
 * `{ claimedAt: null }` also matches documents with no `claimedAt` at all, which
 * is every record written before the field existed.
 */
function claimableFilter(now = new Date()) {
    return {
        status: { $in: ['pending', 'retrying'] },
        $or: [
            { claimedAt: null },
            { claimedAt: { $lte: new Date(now.getTime() - RETRY_LEASE_MS) } },
        ],
    };
}

/**
 * Retry a pending FailedJob by its _id.
 * Runs the supplied handler with the stored payload and updates the DLQ record.
 *
 * The record is claimed by the same update that marks it retrying — one
 * conditional write, before the handler runs. Reading the record, deciding it is
 * retriable and then saving `retrying` would be a check-then-act, and the window
 * is wide enough for two operators running the replay script to both reach the
 * handler: a second `$inc`, or a second inventory grant.
 *
 * A compare-and-set on `attempts` is not enough on its own. It stops two runs
 * that read the same pre-claim state, but not a run that reads *after* the
 * other's claim has landed — that one sees the incremented value and matches on
 * it. Only a lease with a clock can tell an in-flight replay from an abandoned
 * one, which is what `claimedAt` is.
 *
 * The lease is released whichever way the handler ends, so a record that goes
 * back to `pending` is immediately available rather than waiting out its window.
 *
 * @param {string}   failedJobId  - FailedJob._id
 * @param {Function} handler      - async fn(payload) to call
 * @param {string}   resolvedBy   - userId or label for audit trail
 */
async function retryJob(failedJobId, handler, resolvedBy = 'system') {
    const now = new Date();

    const record = await FailedJob.findOneAndUpdate(
        { _id: failedJobId, ...claimableFilter(now) },
        {
            $inc: { attempts: 1 },
            $set: { status: 'retrying', claimedAt: now, claimedBy: resolvedBy, lastAttemptAt: now },
        },
        { new: true },
    );

    // Nothing was claimed. Read the record back to say which of the several
    // reasons it was — the caller is an operator who needs to know whether to
    // wait, look elsewhere, or stop.
    if (!record) {
        const existing = await FailedJob.findById(failedJobId);
        if (!existing) throw new Error('FailedJob not found');
        if (existing.status === 'resolved') throw new Error('Job already resolved');
        if (existing.status === 'exhausted') throw new Error('Job exhausted');
        throw new Error('Job is already being retried by another run');
    }

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

    record.claimedAt = null;
    record.claimedBy = null;
    await record.save();
    return record;
}

module.exports = { runJob, retryJob, claimableFilter, RETRY_LEASE_MS };
