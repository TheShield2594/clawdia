const mongoose = require('mongoose');

module.exports = {
    name: '001_add_indexes',

    async up() {
        const db = mongoose.connection.db;

        // Reminder lookups: due reminders that are not yet completed
        await db.collection('reminders').createIndex(
            { remindAt: 1, completed: 1 },
            { background: true, name: 'idx_remind_due' }
        );

        // Giveaway lookups: active (not ended) giveaways
        await db.collection('guilds').createIndex(
            { 'giveaways.ended': 1, 'giveaways.endsAt': 1 },
            { background: true, name: 'idx_giveaways_active', sparse: true }
        );

        // SLA monitor: open cases with a deadline
        await db.collection('cases').createIndex(
            { status: 1, slaDeadline: 1 },
            { background: true, name: 'idx_cases_sla' }
        );

        // Summary jobs: jobs that are enabled and due at a specific UTC hour/minute
        await db.collection('summaryjobs').createIndex(
            { enabled: 1, hour: 1, minute: 1 },
            { background: true, name: 'idx_summaryjobs_schedule' }
        );

        // RSS feeds: guilds with at least one feed
        await db.collection('guilds').createIndex(
            { 'rssFeeds.0': 1 },
            { background: true, name: 'idx_guilds_rssfeeds', sparse: true }
        );

        // FailedJob querying by status + service
        await db.collection('failedjobs').createIndex(
            { status: 1, service: 1, createdAt: -1 },
            { background: true, name: 'idx_failedjobs_status_service' }
        );
    },
};
