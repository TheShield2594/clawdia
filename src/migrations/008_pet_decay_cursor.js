const mongoose = require('mongoose');

/**
 * Hunger decay now advances from a dedicated `lastDecayAt` cursor instead of
 * reusing `lastFed`. Existing pets have no cursor, and falling back to
 * `lastFed` would retroactively charge every player for the entire period the
 * old (defeatable) decay never billed them for — a pet last fed six months ago
 * would starve the instant its owner ran /pet.
 *
 * So every existing pet starts the new rules from a clean slate: the cursor is
 * set to the migration timestamp, and any stale starvation clock is cleared.
 */
module.exports = {
    name: '008_pet_decay_cursor',

    // Overwrites every pet's starvation clock without keeping the old values;
    // rolling back means restoring the pre-migration backup.
    irreversible: true,

    async up() {
        const db = mongoose.connection.db;

        await db.collection('users').updateMany(
            { 'pets.0': { $exists: true } },
            {
                $set: {
                    'pets.$[].lastDecayAt':     new Date(),
                    'pets.$[].starvingStartAt': null,
                },
            }
        );
    },
};
