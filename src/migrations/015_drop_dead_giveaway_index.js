const mongoose = require('mongoose');

/**
 * Drops `idx_giveaways_active`, the giveaway index migration 001 built on the
 * guilds collection.
 *
 * 001 created it on `{ 'giveaways.ended': 1, 'giveaways.endsAt': 1 }` for a
 * sweep that filtered on both paths. That sweep has since been rewritten:
 * giveawayService.checkGiveaways now asks for `{ 'giveaways.0': { $exists:
 * true } }` and compares `endsAt` in JavaScript, over the giveaways array it
 * already has in memory. Nothing in the codebase filters a query on
 * `giveaways.ended` or `giveaways.endsAt` any more, so the index serves no
 * query while still being written on every guild settings save — and the
 * guilds collection is the one carrying analytics history and inline shop item
 * image Buffers.
 *
 * The replacement is declared in the schema rather than here (#576):
 * `idx_guilds_giveaways`, sparse on `{ 'giveaways.0': 1 }`, which is what the
 * sweep actually asks for. src/models/Guild.js is the single home for this
 * collection's index definitions now; a migration only does the things a schema
 * cannot say, and dropping an index Mongoose will never drop on its own is one
 * of them.
 *
 * 001 is left as it is rather than edited: it is already recorded as applied on
 * every existing deployment, and rewriting an applied migration makes the record
 * lie about what ran. A fresh database builds the index and drops it again
 * moments later, over an empty collection.
 */
module.exports = {
    name: '015_drop_dead_giveaway_index',

    // Housekeeping: the index covers no query, so failing to drop it wastes
    // write throughput and disk and breaks nothing. Left unrecorded on failure
    // so the next boot retries. See the note in runner.js.
    optional: true,

    async up() {
        const guilds = mongoose.connection.db.collection('guilds');

        await guilds.dropIndex('idx_giveaways_active').catch(err => {
            // A database that never ran 001, or one already past this, simply
            // has nothing to drop. NamespaceNotFound (26) is a guilds
            // collection that does not exist yet.
            if (err?.codeName !== 'IndexNotFound' && err?.code !== 26) throw err;
        });
    },

    // The exact inverse is re-running the migration whose index this one
    // dropped — its spec lives in one place instead of being copied here.
    // ensureIndex in 001 is written to be safe to re-run.
    async down() {
        await require('./001_add_indexes').up();
    },
};
