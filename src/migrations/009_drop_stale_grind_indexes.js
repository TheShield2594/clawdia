const mongoose = require('mongoose');

/**
 * Drops the hunt and fishing indexes that migrations 002 and 003 built on the
 * users collection.
 *
 * Both were written while hunt and fishing state still lived on the User
 * document. Migration 005 moved all four grind systems into their own
 * GrindProfile collection and $unset the User fields, so every one of these
 * indexes now covers a path no document has — they cost write throughput and
 * disk while serving no query.
 *
 * Nothing is created in their place. The surviving queries on that data are
 * keyed on { guildId, userId, system } (cooldown claims) or sort by data.xp /
 * data.totalEarned (leaderboards), and GrindProfile already declares indexes
 * for both — see src/models/GrindProfile.js.
 *
 * 002 and 003 are left as they are rather than emptied: they are already
 * recorded as applied on every existing deployment, and rewriting an applied
 * migration makes the record lie about what ran. A fresh database creates the
 * seven indexes and drops them again moments later, which costs one pass over
 * an empty collection.
 */
const STALE_INDEXES = [
    // 002_hunt_indexes
    'idx_hunt_stamina_regen',
    'idx_hunt_leaderboard_earned',
    'idx_hunt_leaderboard_legendary',
    // 003_fishing_indexes
    'idx_fishing_stamina_regen',
    'idx_fishing_leaderboard_earned',
    'idx_fishing_leaderboard_legendary',
    'idx_fishing_last_cast',
];

module.exports = {
    name: '009_drop_stale_grind_indexes',

    async up() {
        const users = mongoose.connection.db.collection('users');

        for (const name of STALE_INDEXES) {
            await users.dropIndex(name).catch(err => {
                // A deployment that never ran 002/003 simply has nothing to drop.
                if (err?.codeName !== 'IndexNotFound') throw err;
            });
        }
    },
};
