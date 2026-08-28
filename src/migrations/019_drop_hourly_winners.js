const mongoose = require('mongoose');

/**
 * Drops `hourlywinners`, the collection behind the hourly micro-competition the
 * weekly champion race replaced.
 *
 * Nothing reads or writes it any more: the model and its util are gone, and the
 * scoreboard lives in `weeklychampions` keyed by ISO week. Its rows expire on
 * their own — the schema carried a 48-hour TTL — so within two days of the
 * upgrade the collection is empty. What does not go away on its own is the
 * collection and its four indexes, which a running mongod keeps indefinitely
 * and which will show up in every index audit as something nobody can account
 * for.
 *
 * Dropped rather than migrated. The two competitions do not share a metric: an
 * hourly row is one player's single best result in one hour, and a weekly row
 * is one player's running total across seven days. There is no meaningful way
 * to seed the second from the first, and a part-week seeded from a handful of
 * surviving hours would hand the first champion a lead nobody could see the
 * origin of. The first weekly race starts from zero for everyone.
 */
module.exports = {
    name: '019_drop_hourly_winners',

    // Housekeeping: the collection is unreferenced and self-emptying, so
    // failing to drop it wastes a little disk and breaks nothing. Left
    // unrecorded on failure so the next boot retries. See the note in runner.js.
    optional: true,

    async up() {
        // `drop()` on a collection that was never created — a fresh database, or
        // one already past this — is NamespaceNotFound rather than a no-op.
        await mongoose.connection.db.collection('hourlywinners').drop().catch(err => {
            if (err?.codeName !== 'NamespaceNotFound' && err?.code !== 26) throw err;
        });
    },

    // Not reversible, and deliberately so: the rows were an hourly leaderboard
    // with a two-day lifetime, and by the time anyone rolls this back they have
    // expired anyway. Recreating an empty collection would only restore the
    // thing this migration exists to remove.
    async down() {},
};
