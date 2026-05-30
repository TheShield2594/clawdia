'use strict';

const BigWin = require('../models/BigWin');

async function logBigWin({ guildId, userId, username, amount, source, details }) {
    try {
        await BigWin.create({ guildId, userId, username, amount, source, details });
    } catch (err) {
        console.error('[bigWin] log failed:', err.message);
    }
}

module.exports = { logBigWin };
