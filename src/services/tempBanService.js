const TempBan = require('../models/TempBan');
const { logModeration } = require('../utils/logger');

async function processExpiredBans(client) {
    const now = new Date();
    const expired = await TempBan.find({ expiresAt: { $lte: now } });

    for (const entry of expired) {
        try {
            const guild = client.guilds.cache.get(entry.guildId);
            if (!guild) { await TempBan.deleteOne({ _id: entry._id }); continue; }

            const bans = await guild.bans.fetch().catch(() => null);
            if (bans?.has(entry.userId)) {
                const bannedUser = bans.get(entry.userId).user;
                await guild.members.unban(entry.userId, 'Temporary ban expired');
                await logModeration(entry.guildId, 'unban', bannedUser, client.user, 'Temporary ban expired');
            }
        } catch (err) {
            console.error(`[TEMPBAN] Failed to unban ${entry.userId} in ${entry.guildId}:`, err);
        } finally {
            await TempBan.deleteOne({ _id: entry._id }).catch(() => {});
        }
    }
}

function startTempBanService(client) {
    // Check immediately on startup, then every 60 seconds
    processExpiredBans(client).catch(console.error);
    setInterval(() => processExpiredBans(client).catch(console.error), 60_000);
}

module.exports = { startTempBanService };
