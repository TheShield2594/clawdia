const mongoose = require('mongoose');

module.exports = {
    name: '023_drop_coinflip_roll_toggles',

    // #1019 folded /coinflip and /roll into /casino coinflip and /casino dice,
    // both gated by `economy.casinoEnabled`. The two standalone toggles no longer
    // switch anything, so they are dropped. $unset discards the values; the way
    // back is the pre-migration backup the runner takes (scripts/restore.sh).
    irreversible: true,

    async up() {
        const db = mongoose.connection.db;

        await db.collection('guilds').updateMany(
            {
                $or: [
                    { 'economy.coinflipEnabled': { $exists: true } },
                    { 'economy.rollEnabled': { $exists: true } },
                ],
            },
            {
                $unset: {
                    'economy.coinflipEnabled': '',
                    'economy.rollEnabled': '',
                },
            }
        );
    },
};
