const mongoose = require('mongoose');

/**
 * Drops `guildId_1` on the fishingtournaments collection, the single-field
 * index Mongoose built from `index: true` on the schema's guildId field.
 *
 * Nothing looks a tournament up by guild alone. Every query in
 * tournamentService pairs the guild with a status — `{ guildId, status:
 * 'active' }` on the read that runs before each scoring cast, and
 * `{ guildId, status: { $in: ['scheduled', 'active'] } }` before a new
 * tournament starts — so the single-field index narrows to the guild and then
 * scans every tournament it has ever run, entries array and all.
 *
 * The replacement is declared in the schema rather than here (#576):
 * `idx_tournament_guild_status` on `{ guildId: 1, status: 1 }`, which autoIndex
 * builds on the next boot. Its first key is guildId, so it answers anything the
 * old index answered and the old one becomes dead weight on every write — but
 * declaring the compound index leaves the single-field one exactly where it is,
 * and dropping an index is not something Mongoose does on its own. Hence this
 * migration (#585).
 */
module.exports = {
    name: '016_fishing_tournament_status_index',

    // Housekeeping: the compound index already answers every query, so failing
    // to drop the old one wastes write throughput and disk and breaks nothing.
    // Left unrecorded on failure so the next boot retries. See runner.js.
    optional: true,

    async up() {
        const tournaments = mongoose.connection.db.collection('fishingtournaments');

        await tournaments.dropIndex('guildId_1').catch(err => {
            // A database whose schema never declared the field-level index has
            // nothing to drop. NamespaceNotFound (26) is a fishingtournaments
            // collection that does not exist yet — no guild has run one.
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
    },

    /**
     * Rebuilds the index under the name Mongoose gave it, so unwinding this
     * leaves the collection indexed the way the pre-#585 schema described.
     */
    async down() {
        const tournaments = mongoose.connection.db.collection('fishingtournaments');
        await tournaments.createIndex({ guildId: 1 }, { name: 'guildId_1' });
    },
};
