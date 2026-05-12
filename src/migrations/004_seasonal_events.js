const mongoose = require('mongoose');

module.exports = {
    name: '004_seasonal_events',

    async up() {
        const db = mongoose.connection.db;

        // Index for quickly finding guilds with an active event
        const guilds = db.collection('guilds');
        let existing = [];
        try { existing = await guilds.indexes(); } catch (e) { if (e?.code !== 26) throw e; }

        const IDX_NAME = 'idx_guilds_active_event';
        if (!existing.find(i => i.name === IDX_NAME)) {
            await guilds.createIndex(
                { 'activeEvent.type': 1, 'activeEvent.endsAt': 1 },
                { name: IDX_NAME, sparse: true }
            );
        }

        // Index for per-user event currency lookups
        const users = db.collection('users');
        let usersIdx = [];
        try { usersIdx = await users.indexes(); } catch (e) { if (e?.code !== 26) throw e; }

        const EC_IDX = 'idx_users_event_currency';
        if (!usersIdx.find(i => i.name === EC_IDX)) {
            await users.createIndex(
                { 'eventCurrency.currencyId': 1 },
                { name: EC_IDX, sparse: true }
            );
        }
    },
};
