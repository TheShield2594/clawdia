const mongoose = require('mongoose');

module.exports = {
    name: '006_drop_wheel_fields',

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
