const mongoose = require('mongoose');

module.exports = {
    name: '002_hunt_indexes',

    async up() {
        const db    = mongoose.connection.db;
        const users = db.collection('users');

        // Stamina regen background-service lookup — sparse is correct for a single optional field
        await users.createIndex(
            { 'hunt.staminaLastRegen': 1 },
            { name: 'idx_hunt_stamina_regen', sparse: true }
        );

        // Leaderboard: only index documents that actually have hunt data
        await users.createIndex(
            { guildId: 1, 'hunt.totalEarned': -1 },
            {
                name: 'idx_hunt_leaderboard_earned',
                partialFilterExpression: { 'hunt.totalEarned': { $exists: true } }
            }
        );

        await users.createIndex(
            { guildId: 1, 'hunt.legendaryKills': -1 },
            {
                name: 'idx_hunt_leaderboard_legendary',
                partialFilterExpression: { 'hunt.legendaryKills': { $exists: true } }
            }
        );
    },

    async down() {
        const db    = mongoose.connection.db;
        const users = db.collection('users');

        for (const name of [
            'idx_hunt_stamina_regen',
            'idx_hunt_leaderboard_earned',
            'idx_hunt_leaderboard_legendary'
        ]) {
            await users.dropIndex(name).catch(err => {
                if (err?.codeName !== 'IndexNotFound') throw err;
            });
        }
    }
};
