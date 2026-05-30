'use strict';

const HourlyWinner = require('../models/HourlyWinner');

function getCurrentHourKey() {
    const d = new Date();
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const hh   = String(d.getUTCHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}`;
}

function getPreviousHourKey() {
    const d = new Date(Date.now() - 3600000);
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const hh   = String(d.getUTCHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}`;
}

// Try to set or update the hourly leader; only replaces if newValue > existing.value.
// Single atomic upsert: inserts if absent, updates if new value beats existing.
async function tryUpdateHourlyWinner({ guildId, category, userId, username, value, details }) {
    const hour = getCurrentHourKey();
    try {
        await HourlyWinner.findOneAndUpdate(
            { guildId, hour, category, $or: [{ value: { $lt: value } }, { value: { $exists: false } }] },
            { $set: { userId, username, value, details }, $setOnInsert: { rewarded: false } },
            { upsert: true, new: true }
        );
    } catch (err) {
        if (err.code !== 11000) console.error('[hourly] update failed:', err.message);
    }
}

async function getCurrentHourlyLeader(guildId, category) {
    const hour = getCurrentHourKey();
    return HourlyWinner.findOne({ guildId, hour, category }).lean();
}

async function getPreviousHourWinners(guildId) {
    const hour = getPreviousHourKey();
    return HourlyWinner.find({ guildId, hour, rewarded: false }).lean();
}

async function markRewarded(ids) {
    if (!ids.length) return;
    await HourlyWinner.updateMany({ _id: { $in: ids } }, { $set: { rewarded: true } });
}

module.exports = {
    getCurrentHourKey,
    getPreviousHourKey,
    tryUpdateHourlyWinner,
    getCurrentHourlyLeader,
    getPreviousHourWinners,
    markRewarded,
};
