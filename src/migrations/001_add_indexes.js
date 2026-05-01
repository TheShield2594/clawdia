const mongoose = require('mongoose');

// Compares two index key specs for equality (same fields, same order, same direction).
function keysEqual(a, b) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i]) return false;
        if (String(a[ak[i]]) !== String(b[bk[i]])) return false;
    }
    return true;
}

// Ensures an index exists with the desired name and options. If an index with
// the same key spec already exists under a different name (e.g. one auto-created
// by Mongoose's schema.index()), it is dropped first so the named version can
// be created. Safe to re-run.
async function ensureIndex(collection, keys, options) {
    let existing = [];
    try {
        existing = await collection.indexes();
    } catch (err) {
        // NamespaceNotFound: collection doesn't exist yet. createIndex below
        // will create it implicitly, so treat as "no existing indexes".
        if (err && err.code !== 26) throw err;
    }

    const sameName = existing.find(i => i.name === options.name);
    if (sameName) return;

    const conflict = existing.find(i => keysEqual(i.key, keys));
    if (conflict) {
        await collection.dropIndex(conflict.name);
    }

    await collection.createIndex(keys, options);
}

module.exports = {
    name: '001_add_indexes',

    async up() {
        const db = mongoose.connection.db;

        // Reminder lookups: due reminders that are not yet completed
        await ensureIndex(
            db.collection('reminders'),
            { remindAt: 1, completed: 1 },
            { name: 'idx_remind_due' }
        );

        // Giveaway lookups: active (not ended) giveaways
        await ensureIndex(
            db.collection('guilds'),
            { 'giveaways.ended': 1, 'giveaways.endsAt': 1 },
            { name: 'idx_giveaways_active', sparse: true }
        );

        // SLA monitor: open cases with a deadline
        await ensureIndex(
            db.collection('cases'),
            { status: 1, slaDeadline: 1 },
            { name: 'idx_cases_sla' }
        );

        // Summary jobs: jobs that are enabled and due at a specific UTC hour/minute
        await ensureIndex(
            db.collection('summaryjobs'),
            { enabled: 1, hour: 1, minute: 1 },
            { name: 'idx_summaryjobs_schedule' }
        );

        // RSS feeds: guilds with at least one feed
        await ensureIndex(
            db.collection('guilds'),
            { 'rssFeeds.0': 1 },
            { name: 'idx_guilds_rssfeeds', sparse: true }
        );

        // FailedJob querying by status + service
        await ensureIndex(
            db.collection('failedjobs'),
            { status: 1, service: 1, createdAt: -1 },
            { name: 'idx_failedjobs_status_service' }
        );
    },
};
