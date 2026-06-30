const mongoose = require('mongoose');

module.exports = {
    name: '002_hunt_indexes',

    async up() {
        const db    = mongoose.connection.db;
        const users = db.collection('users');

        const specs = [
            // Stamina regen background-service lookup — sparse is correct for a single optional field
            [{ 'hunt.staminaLastRegen': 1 }, { name: 'idx_hunt_stamina_regen', sparse: true }],
            // Leaderboard: only index documents that actually have hunt data
            [{ guildId: 1, 'hunt.totalEarned': -1 }, {
                name: 'idx_hunt_leaderboard_earned',
                partialFilterExpression: { 'hunt.totalEarned': { $exists: true } }
            }],
            [{ guildId: 1, 'hunt.legendaryKills': -1 }, {
                name: 'idx_hunt_leaderboard_legendary',
                partialFilterExpression: { 'hunt.legendaryKills': { $exists: true } }
            }]
        ];

        const created = [];
        try {
            for (const [keys, opts] of specs) {
                await users.createIndex(keys, opts);
                created.push(opts.name);
            }
        } catch (err) {
            // Index creation isn't transactional — roll back whatever this run
            // already created so a failed migration doesn't leave partial state.
            for (const name of created) {
                await users.dropIndex(name).catch(() => {});
            }
            throw err;
        }
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
