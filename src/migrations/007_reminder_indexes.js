const mongoose = require('mongoose');

module.exports = {
    name: '007_reminder_indexes',

    // A lookup index for /reminders list and the open-reminder cap check.
    // Missing, both still work, just with a collection scan — not a reason to
    // hold the whole bot down. See the note in runner.js on `optional`.
    optional: true,

    async up() {
        const db = mongoose.connection.db;
        const reminders = db.collection('reminders');

        // Per-user open-reminder lookups: /reminders list and the open-reminder cap check.
        await reminders.createIndex(
            { userId: 1, completed: 1 },
            { name: 'idx_remind_user_open' }
        );
    },

    async down() {
        const db = mongoose.connection.db;
        await db.collection('reminders').dropIndex('idx_remind_user_open').catch(err => {
            if (err?.codeName !== 'IndexNotFound') throw err;
        });
    }
};
