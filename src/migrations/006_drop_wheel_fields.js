const mongoose = require('mongoose');

module.exports = {
    name: '006_drop_wheel_fields',

    // $unset discards the values; nothing keeps a copy to put back. The way
    // back is the pre-migration backup the runner takes before anything
    // irreversible runs (scripts/restore.sh).
    irreversible: true,

    async up() {
        const db = mongoose.connection.db;

        await db.collection('users').updateMany(
            { lastWheelSpin: { $exists: true } },
            { $unset: { lastWheelSpin: '' } }
        );

        await db.collection('guilds').updateMany(
            {
                $or: [
                    { 'economy.wheelEnabled': { $exists: true } },
                    { 'economy.wheelCooldownHours': { $exists: true } },
                    { 'economy.wheelExtraSpinCost': { $exists: true } },
                ],
            },
            {
                $unset: {
                    'economy.wheelEnabled': '',
                    'economy.wheelCooldownHours': '',
                    'economy.wheelExtraSpinCost': '',
                },
            }
        );
    },
};
