'use strict';

const TIER_STYLES = [
    { min: 0,   color: '#cd7f32', label: 'Bronze',  glyph: '⬡' },
    { min: 10,  color: '#c0c0c0', label: 'Silver',  glyph: '◈' },
    { min: 25,  color: '#ffd700', label: 'Gold',    glyph: '◆' },
    { min: 50,  color: '#b9f2ff', label: 'Diamond', glyph: '◇' },
    { min: 100, color: '#ff6200', label: 'Mythic',  glyph: '✦' },
];

/**
 * Apply XP in-memory, processing multi-level threshold crossings.
 * Does NOT save the user. Returns { leveled, newLevel }.
 */
function applyXpGain(user, amount) {
    user.xp = (user.xp || 0) + amount;
    let leveled = false;
    while (user.xp >= (user.level || 0) * 100 + 100) {
        const threshold = (user.level || 0) * 100 + 100;
        user.xp -= threshold;
        user.level = (user.level || 0) + 1;
        leveled = true;
    }
    return { leveled, newLevel: user.level };
}

/**
 * Post a level-up embed to the configured channel (or fallbackChannel),
 * then grant any earned level roles. Safe to fire-and-forget.
 */
async function announceLevelUp(user, guildSettings, member, guild, fallbackChannel) {
    const userOptOut  = user.disableLevelUpAnnounce === true;
    const guildOptOut = guildSettings?.leveling?.disableLevelUpAnnounce === true;

    if (!userOptOut && !guildOptOut) {
        const { EmbedBuilder } = require('discord.js');
        const tierStyle = [...TIER_STYLES].reverse().find(t => user.level >= t.min) ?? TIER_STYLES[0];

        const lvlEmbed = new EmbedBuilder()
            .setColor(tierStyle.color)
            .setTitle(`${tierStyle.glyph} TIER ${tierStyle.label.toUpperCase()} PROMOTION`)
            .setDescription(
                `<@${user.userId}> has advanced to **Level ${user.level}**!\n\n` +
                `*${tierStyle.label} tier — keep climbing!*`
            )
            .setThumbnail(member?.user?.displayAvatarURL({ extension: 'png', size: 128 }) ?? null)
            .setTimestamp();

        const rewardChannelId = guildSettings?.leveling?.rewardChannelId || guildSettings?.leveling?.announceChannel;
        if (guildSettings?.leveling?.announceInChannel && !rewardChannelId && fallbackChannel) {
            await fallbackChannel.send({ embeds: [lvlEmbed] }).catch(console.error);
        } else if (rewardChannelId && guild) {
            const ch = guild.channels.cache.get(rewardChannelId);
            if (ch) await ch.send({ embeds: [lvlEmbed] }).catch(console.error);
        }
    }

    if (guildSettings?.levelRoles?.length && member) {
        const reward = guildSettings.levelRoles
            .filter(lr => lr.level <= user.level)
            .sort((a, b) => b.level - a.level)[0];
        if (reward) await member.roles.add(reward.roleId).catch(console.error);
    }
}

module.exports = { applyXpGain, announceLevelUp };
