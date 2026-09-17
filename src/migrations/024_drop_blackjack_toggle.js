const mongoose = require('mongoose');

module.exports = {
    name: '024_drop_blackjack_toggle',

    // #1020 removed `economy.blackjackEnabled`. Blackjack was a standalone
    // command before the casino existed and kept a per-game toggle no other
    // casino game has; it moved under `/casino` gated by `economy.casinoEnabled`
    // and the leftover switch confused admins who turned the casino on and found
    // blackjack missing. The field is dropped from the schema, the dashboard and
    // the settings payload; this $unset clears a stored `false` so it cannot come
    // back if the read is ever reintroduced. The way back is the pre-migration
    // backup the runner takes (scripts/restore.sh).
    irreversible: true,

    async up() {
        const db = mongoose.connection.db;

        await db.collection('guilds').updateMany(
            { 'economy.blackjackEnabled': { $exists: true } },
            { $unset: { 'economy.blackjackEnabled': '' } }
        );
    },
};
