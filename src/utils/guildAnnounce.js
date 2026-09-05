'use strict';

/**
 * Post one best-effort announcement into a guild channel.
 *
 * Shared by the scheduled domain jobs — wars, economy and ranked seasons, the
 * weekly awards, shop prices, bank interest — which all end the same way: work
 * that has already been committed to the database, followed by a message
 * saying so. That ordering is the whole reason this swallows everything it
 * touches. A missing channel, a deleted guild or a revoked Send Messages
 * permission must never roll back a payout that already landed, so every step
 * here resolves to "nothing posted" rather than throwing back into a sweep
 * that has no way to undo what it just did.
 *
 * It lived in services/schedulerService.js until #931 split that module into
 * its owning domain services; it is here rather than in one of them because
 * all of them post.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {?string} channelId  no channel configured is not an error — nothing is posted
 * @param {object|string} payload  a message payload, a bare string, or a single
 *   embed, which is wrapped as `{ embeds: [payload] }`
 * @returns {Promise<void>}
 */
async function postAnnouncement(client, guildId, channelId, payload) {
    if (!channelId) return;
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;
        await channel.send(typeof payload === 'object' && !payload.embeds ? { embeds: [payload] } : payload).catch(() => {});
    } catch (err) {
        console.error(`[scheduler] announcement post failed for guild ${guildId}:`, err.message);
    }
}

module.exports = { postAnnouncement };
