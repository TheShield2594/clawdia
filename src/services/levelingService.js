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
 * XP needed to leave `level` for the next one.
 *
 * `xp` is progress *within* the current level, not a running total: crossing a
 * threshold spends it. Everything that reads or writes the pair has to agree on
 * that, which is why the rule is one exported function rather than the same
 * arithmetic inlined at each site.
 *
 * @param {number} level
 * @returns {number}
 */
function xpToAdvance(level) {
    return (Number(level) || 0) * 100 + 100;
}

/**
 * Fold any XP at or past the current threshold into levels.
 *
 * Pure, and total: takes a possibly-inconsistent `(level, xp)` pair — the shape
 * a bulk XP grant leaves behind — and returns the consistent one it stands for,
 * with `xp` back below `xpToAdvance(level)`.
 *
 * Solved rather than looped. Advancing `k` levels from `level` costs
 * `50k² + (100·level + 50)k`, so the largest affordable `k` is the positive root
 * of that quadratic; the two correction steps settle the rounding, because at a
 * fifteen-digit XP total the square root is a float and can land a step either
 * side of the exact answer. The loop it replaces ran once per level, and the
 * dashboard's ceiling of 1e15 XP buys about 4.5 million of them (#924).
 *
 * @param {number} level
 * @param {number} xp
 * @returns {{ level: number, xp: number }}
 */
function normalizeLevelProgress(level, xp) {
    const startLevel = Math.max(0, Math.floor(Number(level) || 0));
    const pool = Math.max(0, Math.floor(Number(xp) || 0));
    if (pool < xpToAdvance(startLevel)) return { level: startLevel, xp: pool };

    const b = 100 * startLevel + 50;
    const costOf = k => 50 * k * k + b * k;

    let levels = Math.max(0, Math.floor((Math.sqrt(b * b + 200 * pool) - b) / 100));
    while (levels > 0 && costOf(levels) > pool) levels--;
    while (costOf(levels + 1) <= pool) levels++;

    return { level: startLevel + levels, xp: pool - costOf(levels) };
}

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

    const settled = normalizeLevelProgress(user.level, (user.xp || 0) + gained);
    const leveled = settled.level > (user.level || 0);
    user.xp = settled.xp;
    user.level = settled.level;
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

module.exports = { applyXpGain, announceLevelUp, normalizeLevelProgress, xpToAdvance };
