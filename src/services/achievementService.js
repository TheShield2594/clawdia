'use strict';

const { ACHIEVEMENTS } = require('../data/achievements');
const { delay } = require('../utils/delay');
const { createAchievementCard } = require('../utils/cardGenerator');

/**
 * Check all applicable achievements for a user and award any newly earned ones.
 * Call this after any stat-changing operation, before user.save().
 *
 * @param {object} user           - Mongoose user document (already modified, not yet saved)
 * @param {object} guildSettings  - Mongoose guild document
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
        user.achievementsCount = (user.achievementsCount || 0) + 1;
        earnedIds.add(def.id);
        newlyEarned.push(def);
    }

    // Announcement is deferred — callers must call announceAchievements after user.save()
    return newlyEarned;
}

// XP → embed color tier
function getTierColor(xpReward) {
    if (!xpReward || xpReward <= 50)  return 0x9e9e9e; // common
    if (xpReward <= 200)              return 0x4caf50; // uncommon
    if (xpReward <= 500)              return 0x2196f3; // rare
    if (xpReward <= 999)              return 0x9c27b0; // epic
    return 0xFFD700;                                    // legendary
}

/**
 * Post achievement unlock announcements to the configured channel.
 * Each achievement is revealed in two steps (mystery → reveal) with an 800ms gap,
 * and multiple unlocks are staggered with 400ms between them.
 */
async function announceAchievements(client, guildSettings, user, member, achievements) {
    const channelId = guildSettings.achievements?.announcementChannelId;
    if (!channelId) return;

    const guild = client.guilds.cache.get(guildSettings.guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
    const mention = member?.displayName ? `${member.displayName} (<@${user.userId}>)` : `<@${user.userId}>`;

    for (let i = 0; i < achievements.length; i++) {
        if (i > 0) await delay(400);

        const ach = achievements[i];
        const tierColor = getTierColor(ach.xpReward);

        // Step 1 — mystery beat
        const mysteryEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🏅 Achievement Unlocked...')
            .setDescription('???');

        const msg = await channel.send({ embeds: [mysteryEmbed] }).catch(() => null);
        if (!msg) continue;

        await delay(800);

        // Step 2 — reveal with canvas image
        const separator = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
        const rewards = [];
        if (ach.xpReward)   rewards.push(`+${ach.xpReward} XP`);
        if (ach.coinReward) rewards.push(`+${ach.coinReward.toLocaleString()} coins`);
        const rewardLine = rewards.length ? `${separator}\n  ${rewards.join('  ·  ')}\n${separator}` : separator;

        const revealEmbed = new EmbedBuilder()
            .setColor(tierColor)
            .setTitle('🏅 Achievement Unlocked!')
            .setDescription(
                `${ach.emoji || ''} **${ach.name}**\n\n${ach.description}\n\n${rewardLine}\n  ${mention}`
            )
            .setFooter({ text: 'Use /achievements to view all achievements' });

        // Attach the Minecraft-style canvas card
        let files = [];
        try {
            const buf = await createAchievementCard(ach.name, ach.description, ach.xpReward);
            revealEmbed.setImage('attachment://achievement.png');
            files = [new AttachmentBuilder(buf, { name: 'achievement.png' })];
        } catch { /* non-critical — send embed without card */ }

        await msg.edit({ embeds: [revealEmbed], files }).catch(() => null);
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
    user.achievementsCount = (user.achievementsCount || 0) + 1;
    return true;
}

module.exports = { checkAndAward, announceAchievements, grantCustomAchievement };
