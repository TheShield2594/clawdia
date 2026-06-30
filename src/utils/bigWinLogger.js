'use strict';

const BigWin = require('../models/BigWin');

const SOURCE_LABELS = {
    hunt:   { emoji: '🏹', label: 'Hunt' },
    fish:   { emoji: '🎣', label: 'Fishing' },
    mine:   { emoji: '⛏️', label: 'Mining' },
    casino: { emoji: '🎰', label: 'Casino' },
};

async function logBigWin({ guildId, userId, username, amount, source, details, client }) {
    try {
        await BigWin.create({ guildId, userId, username, amount, source, details });
    } catch (err) {
        console.error('[bigWin] log failed:', err.message);
    }

    if (!client) return;

    try {
        const Guild = require('../models/Guild');
        const guildSettings = await Guild.findOne({ guildId }).lean();
        if (guildSettings?.economy?.announceRareDrops === false) return;

        const channelId = guildSettings.economy?.announcementChannelId;
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) return;

        const src = SOURCE_LABELS[source] ?? { emoji: '🌟', label: source };
        const displayName = details?.itemName ?? details?.ore ?? 'rare drop';
        const rarity = details?.rarity ?? '';

        await channel.send(
            `${src.emoji} **Rare Drop!** <@${userId}> just got a **${rarity ? rarity + ' ' : ''}${displayName}** from ${src.label}! ` +
            `${amount ? `Worth roughly **${amount.toLocaleString()} coins**.` : ''}`
        );
    } catch (err) {
        console.error('[bigWin] broadcast failed:', err.message);
    }
}

module.exports = { logBigWin };
