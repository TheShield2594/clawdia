'use strict';

const { ACHIEVEMENTS } = require('../data/achievements');

/**
 * Check all applicable achievements for a user and award any newly earned ones.
 * Call this after any stat-changing operation, before user.save().
 *
 * @param {object} user           - Mongoose user document (already modified, not yet saved)
 * @param {object} guildSettings  - Mongoose guild document
 * @param {object} client         - Discord.js client (for announcement posting)
 * @param {object} member         - GuildMember for the user (optional, used for DMs / name display)
 * @returns {Array} newly earned achievement definitions (built-in + custom)
 */
async function checkAndAward(user, guildSettings) {
    if (!guildSettings?.achievements?.enabled) return [];

    const disabled = new Set(guildSettings.achievements?.disabledAchievements || []);
    const earnedIds = new Set((user.achievements || []).map(a => a.id));

    const newlyEarned = [];

    // ── Built-in achievements ─────────────────────────────────────────────
    for (const def of ACHIEVEMENTS) {
        if (disabled.has(def.id)) continue;
        if (earnedIds.has(def.id)) continue;

        let earned = false;
        try {
            earned = def.check(user, guildSettings);
        } catch {
            // silently skip a broken check
        }

        if (!earned) continue;

        user.achievements = user.achievements || [];
        user.achievements.push({ id: def.id, earnedAt: new Date(), claimed: false });
        earnedIds.add(def.id);
        newlyEarned.push(def);
    }

    // Announcement is deferred — callers must call announceAchievements after user.save()
    return newlyEarned;
}

/**
 * Post achievement unlock announcements to the configured channel.
 */
async function announceAchievements(client, guildSettings, user, member, achievements) {
    const channelId = guildSettings.achievements?.announcementChannelId;
    if (!channelId) return;

    const guild = client.guilds.cache.get(guildSettings.guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    const { EmbedBuilder } = require('discord.js');
    const displayName = member?.displayName || `<@${user.userId}>`;

    for (const ach of achievements) {
        const embed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(`${ach.emoji} Achievement Unlocked!`)
            .setDescription(`**${displayName}** earned **${ach.name}**\n${ach.description}`)
            .setFooter({ text: `Use /achievements to view all achievements` });

        const rewards = [];
        if (ach.xpReward)   rewards.push(`+${ach.xpReward} XP`);
        if (ach.coinReward) rewards.push(`+${ach.coinReward.toLocaleString()} coins`);
        if (rewards.length) embed.addFields({ name: 'Rewards (use /achievements claim)', value: rewards.join(' · '), inline: false });

        await channel.send({ embeds: [embed] }).catch(() => null);
    }
}

/**
 * Grant a custom achievement to a user by ID.
 * Returns true if the achievement was newly granted, false if already had it.
 */
async function grantCustomAchievement(user, achievementId) {
    const already = (user.achievements || []).some(a => a.id === achievementId);
    if (already) return false;
    user.achievements = user.achievements || [];
    user.achievements.push({ id: achievementId, earnedAt: new Date(), claimed: false });
    return true;
}

module.exports = { checkAndAward, announceAchievements, grantCustomAchievement };
