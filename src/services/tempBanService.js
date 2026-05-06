const TempBan = require('../models/TempBan');
const { logModeration } = require('../utils/logger');

let processing = false;

async function processExpiredBans(client) {
    if (processing) return;
    processing = true;

    try {
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
                console.error(`[TEMPBAN] Failed to unban ${entry.userId} in ${entry.guildId}:`, err);
            }
        }
    } finally {
        processing = false;
    }
}

function startTempBanService(client) {
    processExpiredBans(client).catch(console.error);
    setInterval(() => processExpiredBans(client).catch(console.error), 60_000);
}

module.exports = { startTempBanService };
