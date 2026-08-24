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
 * `idx_tournament_guild_status` on `{ guildId: 1, status: 1 }`. Its first key is
 * guildId, so it answers anything the old index answered and the old one becomes
 * dead weight on every write — but declaring the compound index leaves the
 * single-field one exactly where it is, and dropping an index is not something
 * Mongoose does on its own. Hence this migration (#585).
 */
module.exports = {
    name: '016_fishing_tournament_status_index',

    // Housekeeping: the compound index already answers every query, so failing
    // to drop the old one wastes write throughput and disk and breaks nothing.
    // Left unrecorded on failure so the next boot retries. See runner.js.
    optional: true,

    async up() {
        const tournaments = mongoose.connection.db.collection('fishingtournaments');

        // Built here rather than left to autoIndex, and awaited before anything
        // is dropped. Migrations run seconds after the connection opens and
        // before a command or service has required the model, so autoIndex has
        // not compiled the schema yet: dropping first would leave every
        // tournament lookup with no index at all until some later require
        // catches up, and autoIndex builds in the background without being
        // awaited by anything.
        //
        // createIndex is idempotent for an index that already exists with this
        // exact spec and name, so a boot that has been here before does nothing.
        await tournaments.createIndex({ guildId: 1, status: 1 }, { name: 'idx_tournament_guild_status' });

        await tournaments.dropIndex('guildId_1').catch(err => {
            // A database whose schema never declared the field-level index has
            // nothing to drop. NamespaceNotFound (26) is a fishingtournaments
            // collection that does not exist yet — no guild has run one.
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
    },

    /**
     * The exact inverse: the single-field index back under the name Mongoose
     * gave it, and the compound index gone, which is the collection the pre-#585
     * schema describes — the image being rolled back to declares `index: true`
     * on guildId and nothing about status.
     *
     * In that order, so there is no moment where a tournament lookup has no
     * index on guildId to use.
     */
    async down() {
        const tournaments = mongoose.connection.db.collection('fishingtournaments');

        await tournaments.createIndex({ guildId: 1 }, { name: 'guildId_1' });

        await tournaments.dropIndex('idx_tournament_guild_status').catch(err => {
            // Same two cases up() allows for: a database that never got this
            // far, and a collection no guild has ever written to.
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
    },
};
