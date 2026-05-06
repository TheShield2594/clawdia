const mongoose = require('mongoose');

module.exports = {
    name: '002_hunt_indexes',

    async up() {
        const db = mongoose.connection.db;
        const users = db.collection('users');

        // Fast lookup of users due for stamina regen (background service candidate)
        await users.createIndex(
            { 'hunt.staminaLastRegen': 1 },
            { name: 'idx_hunt_stamina_regen', sparse: true }
        );

        // Leaderboard queries by guild + hunt stats
        await users.createIndex(
            { guildId: 1, 'hunt.totalEarned': -1 },
            { name: 'idx_hunt_leaderboard_earned', sparse: true }
        );

        await users.createIndex(
            { guildId: 1, 'hunt.legendaryKills': -1 },
            { name: 'idx_hunt_leaderboard_legendary', sparse: true }
        );
    }
};
