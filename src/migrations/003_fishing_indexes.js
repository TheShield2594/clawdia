const mongoose = require('mongoose');

module.exports = {
    name: '003_fishing_indexes',

    async up() {
        const db    = mongoose.connection.db;
        const users = db.collection('users');

        // Stamina regen background-service lookup
        await users.createIndex(
            { 'fishing.staminaLastRegen': 1 },
            { name: 'idx_fishing_stamina_regen', sparse: true }
        );

        // Leaderboard: total coins earned from fishing
        await users.createIndex(
            { guildId: 1, 'fishing.totalEarned': -1 },
            {
                name: 'idx_fishing_leaderboard_earned',
                partialFilterExpression: { 'fishing.totalEarned': { $exists: true } }
            }
        );

        // Leaderboard: legendary catches
        await users.createIndex(
            { guildId: 1, 'fishing.legendaryCatches': -1 },
            {
                name: 'idx_fishing_leaderboard_legendary',
                partialFilterExpression: { 'fishing.legendaryCatches': { $exists: true } }
            }
        );

        // Cast cooldown quick lookup
        await users.createIndex(
            { guildId: 1, 'fishing.lastCast': -1 },
            { name: 'idx_fishing_last_cast', sparse: true }
        );
    },

    async down() {
        const db    = mongoose.connection.db;
        const users = db.collection('users');

        for (const name of [
            'idx_fishing_stamina_regen',
            'idx_fishing_leaderboard_earned',
            'idx_fishing_leaderboard_legendary',
            'idx_fishing_last_cast'
        ]) {
            await users.dropIndex(name).catch(err => {
                if (err?.codeName !== 'IndexNotFound') throw err;
            });
        }
    }
};
