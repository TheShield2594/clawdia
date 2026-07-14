const { Schema, model } = require('mongoose');

const reminderSchema = new Schema({
    userId: { type: String, required: true },
    guildId: { type: String, default: null },
    channelId: { type: String, required: true },
    message: { type: String, required: true },
    remindAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
    completed: { type: Boolean, default: false },
    // Recurring cadence — null means one-time. When set, checkReminders reschedules
    // remindAt to the next occurrence instead of marking the reminder completed.
    repeatInterval: { type: String, enum: ['daily', 'weekly', null], default: null },
    // IANA timezone snapshotted at creation time, used to reschedule recurring
    // reminders on calendar days (DST-safe) rather than fixed millisecond offsets.
    timezone: { type: String, default: null }
});

// Index for per-user open-reminder lookups (/reminders list, open-reminder cap check)
// is managed in src/migrations/007_reminder_indexes.js, matching this model's existing
// remindAt/completed index which is likewise migration-managed rather than declared here.

module.exports = model('Reminder', reminderSchema);