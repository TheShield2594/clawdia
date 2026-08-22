const TempBan = require('../models/TempBan');
const { logModeration } = require('../utils/logger');

// Registered in services/scheduler as a job rather than owning a setInterval
// here (#611). runJob now owns the overlap guard this used to keep for itself
// in a `processing` flag, and — the part the flag never gave — records the run
// on the health payload and files a dead-letter entry when the sweep throws.
// Before that, an expired ban that failed to lift failed invisibly.
async function processExpiredBans(client) {
    const now = new Date();
    const expired = await TempBan.find({ expiresAt: { $lte: now } });

    for (const entry of expired) {
        try {
            const guild = client.guilds.cache.get(entry.guildId);
            if (!guild) {
                await TempBan.deleteOne({ _id: entry._id });
                continue;
            }

            const ban = await guild.bans.fetch(entry.userId).catch(() => null);
            if (ban) {
                await guild.members.unban(entry.userId, 'Temporary ban expired');
                await logModeration(entry.guildId, 'unban', ban.user, client.user, 'Temporary ban expired');
            }

            await TempBan.deleteOne({ _id: entry._id });
        } catch (err) {
            // One ban that will not lift — a deleted guild, a missing
            // permission — must not strand the rest of the sweep, so this stays
            // per-entry rather than failing the whole job.
            console.error(`[TEMPBAN] Failed to unban ${entry.userId} in ${entry.guildId}:`, err);
        }
    }
}

module.exports = { processExpiredBans };
