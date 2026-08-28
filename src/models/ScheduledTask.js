const { Schema, model } = require('mongoose');

/**
 * A thing to do later, once or on a cadence (#834).
 *
 * Every dynamic schedule in this codebase used to be built from scratch. The
 * newspaper is `Guild` fields plus an hourly window claim; the daily digest is
 * minute-equality matching against a configured hour; the daily news is its own
 * per-profile due check. Each one re-derives "is it time yet", "did we already
 * run", and "what happens after downtime" — and gets at least one of them
 * subtly wrong.
 *
 * The Reminder pattern is the only one of them that is restart-proof and
 * self-healing, and it is the simplest: persist when the thing is due, scan for
 * `<= now` every minute, reschedule or retire it afterwards. This is that
 * pattern generalized, so a new kind of scheduled work is a handler in
 * `scheduledTaskService` and nothing else — it inherits the overlap guard, the
 * dead-letter queue and the health surface from the one `JOBS` entry that
 * drives it.
 */
const scheduledTaskSchema = new Schema({
    guildId: { type: String, required: true, index: true },

    // What to do when it fires — the key into the service's handler registry.
    // An unknown kind is a task written by a newer version of the bot than the
    // one reading it; the service disables such a task rather than retrying it
    // every minute forever.
    kind: { type: String, required: true, default: 'ai_prompt' },

    // Where the result goes. Required for every kind there is so far, since all
    // of them post something; a future kind that writes nowhere can leave it.
    channelId: { type: String, default: null },

    // Who asked for it: a user ID for a task somebody created, or null for one
    // the operator or a migration installed. Also what the per-person cap in
    // `utils/scheduledTaskLimits.js` counts.
    createdBy: { type: String, default: null },

    // The instruction for an `ai_prompt` task, in the words of whoever set it.
    // Treated as the user's request to the model, not as system instruction —
    // see the handler, which says so in as many words.
    prompt: { type: String, default: null },

    // Anything a non-prompt kind needs. Deliberately untyped: the point of this
    // collection is that a new kind does not need a schema change, and each
    // handler validates its own config.
    config: { type: Schema.Types.Mixed, default: null },

    // When it is next due. The scan is `fireAt <= now`, so a task whose time
    // passed during downtime fires on the next tick rather than being missed —
    // which is the whole reason for storing an instant rather than a cron line.
    fireAt: { type: Date, required: true },

    // null means one-shot: the task is disabled after it runs rather than
    // rescheduled. The repeating cadences advance on calendar units in the
    // task's timezone, so a daily task stays at the same local time across DST.
    repeat: { type: String, enum: ['daily', 'weekly', 'monthly', null], default: null },
    timezone: { type: String, default: 'Etc/UTC' },

    // The day of the month a monthly task actually means, snapshotted at
    // creation from `fireAt` in the task's own timezone.
    //
    // Needed because clamping is lossy in one direction: a task on the 31st
    // clamps to the 28th in February, and stepping from *that* gives the 28th
    // of March — the 31st is gone after one short month. Each step is measured
    // from this instead, so the run lands on the 31st again whenever the month
    // has one. Null on a task written before the field existed, which reads as
    // the old clamping behaviour rather than as an error.
    monthDay: { type: Number, default: null, min: 1, max: 31 },

    // Off rather than deleted, so an admin can suspend a task and keep it, and
    // so a task that failed too many times leaves evidence of why.
    enabled: { type: Boolean, default: true },

    lastRun: { type: Date, default: null },
    runCount: { type: Number, default: 0 },
    // Consecutive failures. Reset on success; past MAX_TASK_FAILURES the
    // service switches the task off rather than spending the guild's tokens on
    // the same broken run every day.
    failureCount: { type: Number, default: 0 },
    lastError: { type: String, default: null },

    createdAt: { type: Date, default: Date.now }
});

// The scan every minute: due, and switched on. Compound in that order because
// `fireAt` is the selective half — most tasks are enabled and few are due.
scheduledTaskSchema.index({ fireAt: 1, enabled: 1 });
// The caps and the listings, both of which ask per guild.
scheduledTaskSchema.index({ guildId: 1, enabled: 1 });

module.exports = model('ScheduledTask', scheduledTaskSchema);
