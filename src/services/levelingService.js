'use strict';

// Levelling: applying XP across level thresholds, and announcing a promotion.
//
// This was `utils/applyXpGain.js`, and it imported `services/petService` for the
// Bird's `xp_gain` passive — a util reaching up into a service (#614). The pet
// bonus is not incidental to it: applying XP *is* consulting the pet passive,
// which is why the bonus lives here rather than at each call site. So the
// module is a service, and now sits with the one it depends on.

const { getTotalBonus } = require('./petService');

const TIER_STYLES = [
    { min: 0,   color: '#cd7f32', label: 'Bronze',  glyph: '⬡' },
    { min: 10,  color: '#c0c0c0', label: 'Silver',  glyph: '◈' },
    { min: 25,  color: '#ffd700', label: 'Gold',    glyph: '◆' },
    { min: 50,  color: '#b9f2ff', label: 'Diamond', glyph: '◇' },
    { min: 100, color: '#ff6200', label: 'Mythic',  glyph: '✦' },
];

/**
 * Apply XP in-memory, processing multi-level threshold crossings.
 *
 * Applies any `xp_gain` pet passive (the Bird) here rather than at each call
 * site, so every source of levelling XP benefits from it consistently.
 * Does NOT save the user.
 *
 * Returns { leveled, newLevel, gained, petBonusPct } — `gained` is the amount
 * actually credited after the pet bonus, and is what callers should display.
 */
function applyXpGain(user, amount) {
    const petBonusPct = getTotalBonus(user?.pets ?? [], 'xp_gain');
    const gained = Math.max(0, Math.floor(amount * (1 + petBonusPct / 100)));

    user.xp = (user.xp || 0) + gained;
    let leveled = false;
    while (user.xp >= (user.level || 0) * 100 + 100) {
        const threshold = (user.level || 0) * 100 + 100;
        user.xp -= threshold;
        user.level = (user.level || 0) + 1;
        leveled = true;
    }
    return { leveled, newLevel: user.level, gained, petBonusPct };
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
