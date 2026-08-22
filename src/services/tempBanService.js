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

    let failed = 0;

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
            failed += 1;
            console.error(`[TEMPBAN] Failed to unban ${entry.userId} in ${entry.guildId}:`, err);
        }
    }

    // The per-entry catch above is what keeps one bad ban from stranding the
    // rest — but on its own it also means a sweep where every unban failed
    // returns normally, and runJob records a healthy run. That is the invisible
    // failure #611 is about, one level down. Failing the job here is what puts
    // it on /health and in the dead-letter queue; the entries themselves are
    // untouched, so the next tick retries them.
    if (failed) {
        throw new Error(`${failed} of ${expired.length} expired ban(s) could not be lifted`);
    }
}

module.exports = { processExpiredBans };
