const mongoose = require('mongoose');

/**
 * Moves the four grind subsystems (fishing, hunt, mining, exploration) out of
 * the User document into the grindprofiles collection — one document per
 * user × system. These subsystems hold unbounded nested state (gear arrays,
 * material maps, journals) that pushed heavy users toward the 16MB document
 * limit and made every command pay to load them.
 *
 * Runs entirely server-side via aggregation $merge so large installs stay
 * within the migration timeout. Idempotent: $merge keeps existing profile
 * documents, and already-moved users no longer match the $unset filter.
 */
module.exports = {
    name: '005_grind_profiles',

    async up() {
        const db       = mongoose.connection.db;
        const users    = db.collection('users');
        const profiles = db.collection('grindprofiles');

        // $merge upserts require a unique index on the "on" fields
        let existing = [];
        try { existing = await profiles.indexes(); } catch (e) { if (e?.code !== 26) throw e; }
        const UNIQ = 'idx_grind_user_system';
        if (!existing.find(i => i.name === UNIQ)) {
            await profiles.createIndex(
                { guildId: 1, userId: 1, system: 1 },
                { name: UNIQ, unique: true }
            );
        }

        const now = new Date();
        for (const system of ['fishing', 'hunt', 'mining', 'exploration']) {
            await users.aggregate([
                { $match: { [system]: { $exists: true, $ne: null } } },
                { $project: {
                    _id:       0,
                    guildId:   1,
                    userId:    1,
                    system:    { $literal: system },
                    data:      `$${system}`,
                    createdAt: { $literal: now },
                    updatedAt: { $literal: now },
                } },
                { $merge: {
                    into:           'grindprofiles',
                    on:             ['guildId', 'userId', 'system'],
                    whenMatched:    'keepExisting',
                    whenNotMatched: 'insert',
                } },
            ]).toArray();

            await users.updateMany(
                { [system]: { $exists: true } },
                { $unset: { [system]: '' } }
            );
        }

        // Leaderboard indexes for the new collection
        let profIdx = [];
        try { profIdx = await profiles.indexes(); } catch (e) { if (e?.code !== 26) throw e; }
        if (!profIdx.find(i => i.name === 'idx_grind_lb_xp')) {
            await profiles.createIndex(
                { guildId: 1, system: 1, 'data.xp': -1 },
                { name: 'idx_grind_lb_xp' }
            );
        }
        if (!profIdx.find(i => i.name === 'idx_grind_lb_earned')) {
            await profiles.createIndex(
                { guildId: 1, system: 1, 'data.totalEarned': -1 },
                { name: 'idx_grind_lb_earned' }
            );
        }
    },
};
