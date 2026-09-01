'use strict';

const { ACHIEVEMENTS } = require('../data/achievements');
const { delay } = require('../utils/delay');
const { createAchievementCard } = require('../utils/cardGenerator');
const COLORS = require('../utils/embedColors');

/**
 * Check all applicable achievements for a user and award any newly earned ones.
 * Call this after any stat-changing operation, before user.save().
 *
 * The scan repeats until a pass awards nothing. One achievement reads what the
 * others have earned — Completionist wants 20 non-secret unlocks — and a single
 * ordered pass only sees the ones defined *above* it in the list. The tiered
 * hunt/angler/miner/gambler badges were appended below Completionist, so a
 * player whose twentieth unlock was Hunter Gold stayed locked out of it until
 * some later, unrelated check happened to run. Iterating to a fixed point makes
 * the award independent of where a definition sits in the array, which is not a
 * property anything should have to remember when adding one.
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
    // Bounded by the definition count: every pass after the first is entered
    // only because the one before it awarded something, and nothing is awarded
    // twice, so this cannot run more times than there are achievements.
    let awardedThisPass = true;
    while (awardedThisPass) {
        awardedThisPass = false;

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
            awardedThisPass = true;
        }
    }

    // Announcement is deferred — callers must call announceAchievements after user.save()
    return newlyEarned;
}

/**
 * checkAndAward for a caller that must not save the whole user document.
 *
 * The casino is the case this exists for. A hand's stake is debited with an
 * atomic `$inc` while the player's balance is moving under several other
 * writers, and `user.save()` writes `balance` back as an absolute `$set` — so
 * saving the document a wager was read from is exactly the "a casino debit
 * landing between this read and that save would simply be erased" hazard
 * messageCreate already guards against. Awarding through a targeted update
 * writes the two achievement fields and nothing else.
 *
 * The filter refuses to write if any of the ids are already on the document, so
 * two hands settling at once cannot both award the same achievement; the loser
 * of that race gets an empty array back and announces nothing.
 *
 * `user` is still mutated by the checkAndAward inside, so the caller must not
 * also save it — the whole point is that this write is the only one.
 *
 * @param {object} User           the User model
 * @param {object} filter         `{ userId, guildId }` for the update
 * @param {object} user           the document to evaluate (not saved)
 * @param {object} guildSettings
 * @returns {Promise<Array>} newly earned definitions that this call persisted
 */
async function checkAndAwardAtomic(User, filter, user, guildSettings) {
    const newlyEarned = await checkAndAward(user, guildSettings);
    if (!newlyEarned.length) return [];

    const ids = newlyEarned.map(def => def.id);
    const entries = ids.map(id => ({ id, earnedAt: new Date(), claimed: false }));

    const res = await User.updateOne(
        { ...filter, 'achievements.id': { $nin: ids } },
        {
            $push: { achievements: { $each: entries } },
            $inc:  { achievementsCount: entries.length },
        },
    );

    const wrote = res?.modifiedCount ?? res?.nModified ?? 0;
    return wrote > 0 ? newlyEarned : [];
}

// XP → embed color tier
function getTierColor(xpReward) {
    if (!xpReward || xpReward <= 50)  return 0x9e9e9e; // common
    if (xpReward <= 200)              return 0x4caf50; // uncommon
    if (xpReward <= 500)              return 0x2196f3; // rare
    if (xpReward <= 999)              return 0x9c27b0; // epic
    return 0xFFD700;                                    // legendary
}

// XP + secret flag → announcement tier
// Returns 'none' | 'rare' | 'secret' | 'legendary'
function getAnnounceTier(def) {
    if (def.secret)                           return 'secret';
    if (!def.xpReward || def.xpReward <= 200) return 'none';     // common/uncommon
    if (def.xpReward <= 999)                  return 'rare';
    return 'legendary';
}

// Rank order for non-secret tiers only (secret is handled orthogonally)
const ANNOUNCE_TIER_ORDER = { none: 0, rare: 1, legendary: 2 };

function tierMeetsThreshold(tier, threshold) {
    // Secret achievements always broadcast regardless of threshold
    if (tier === 'secret') return true;
    const min = ANNOUNCE_TIER_ORDER[threshold] ?? ANNOUNCE_TIER_ORDER['rare'];
    return (ANNOUNCE_TIER_ORDER[tier] ?? 0) >= min;
}

/**
 * Send a server-wide announcement for notable achievement unlocks.
 * Tiers: rare = brief mention, secret = redacted, legendary = fancy bordered.
 * Uses the same announcementChannelId as the per-user reveal to avoid needing
 * a separate dashboard field; skips broadcast if both channels are identical
 * (prevent duplicate when the reveal channel IS the announce channel).
 * Respects `achievementAnnounceThreshold` guild setting ('rare'|'secret'|'legendary').
 */
async function broadcastAchievementUnlock(client, guildSettings, mention, def, revealChannelId) {
    const channelId = guildSettings.achievements?.announcementChannelId;
    if (!channelId) return;

    // Skip broadcast if it would post to the same channel as the per-user reveal
    if (channelId === revealChannelId) return;

    const tier = getAnnounceTier(def);
    const threshold = guildSettings.achievements?.achievementAnnounceThreshold ?? 'rare';
    if (!tierMeetsThreshold(tier, threshold)) return;

    const guild = client.guilds.cache.get(guildSettings.guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    const { EmbedBuilder } = require('discord.js');

    let embed;
    if (tier === 'legendary') {
        const bar = '⚡ ════════════════════════ ⚡';
        embed = new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle(`${bar}`)
            .setDescription(
                `${bar}\n👑 ${mention} just achieved the legendary\n\n` +
                `**${def.emoji || '🏆'} ${def.name.toUpperCase()}**\n\n` +
                `${def.description}\n${bar}`
            )
            .setTimestamp();
    } else if (tier === 'secret') {
        embed = new EmbedBuilder()
            .setColor(COLORS.RARE)
            .setTitle('✨ Secret Achievement Discovered!')
            .setDescription(
                `${mention} just discovered a **secret achievement**…\n\n🔒 *"[REDACTED]"*\n\nCan you find it too?`
            )
            .setTimestamp();
    } else {
        // rare
        embed = new EmbedBuilder()
            .setColor(getTierColor(def.xpReward))
            .setTitle('🏆 Achievement Unlocked')
            .setDescription(`${def.emoji || '🏆'} ${mention} just unlocked **${def.name}** — ${def.description}`)
            .setTimestamp();
    }

    channel.send({ embeds: [embed] }).catch(() => null);
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
            .setColor(COLORS.INFO)
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
            files = [new AttachmentBuilder(buf, {
                name: 'achievement.png',
                description: `Achievement card: ${ach.name} — ${ach.description}`,
            })];
        } catch { /* non-critical — send embed without card */ }

        await msg.edit({ embeds: [revealEmbed], files }).catch(() => null);

        // Server-wide broadcast for notable unlocks (fire-and-forget, skips if same channel)
        broadcastAchievementUnlock(client, guildSettings, mention, ach, channelId).catch(() => null);
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

module.exports = { checkAndAward, checkAndAwardAtomic, announceAchievements, grantCustomAchievement };
