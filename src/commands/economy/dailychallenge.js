'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { hasUnlock } = require('../../utils/prestige');
const { logTransaction } = require('../../utils/logTransaction');

const CLAIM_COOLDOWN_MS = 24 * 3_600_000;
const BASE_REWARD_COINS = 5_000;
const BASE_REWARD_XP    = 250;

// Pool of flavor objectives shown to the player — purely cosmetic framing;
// the reward is a flat prestige-gated bonus, not tracked per-objective.
const OBJECTIVES = [
    { emoji: '⚔️', text: 'Land 5 successful hunts.' },
    { emoji: '🎣', text: 'Reel in 5 catches.' },
    { emoji: '⛏️', text: 'Complete 5 mining runs.' },
    { emoji: '💰', text: 'Earn 10,000 coins from any source.' },
    { emoji: '🦹', text: 'Pull off a successful /crime.' },
    { emoji: '💬', text: 'Stay active in chat today.' },
];

function pickObjective(userId, dayKey) {
    let hash = 0;
    const seed = `${userId}:${dayKey}`;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    return OBJECTIVES[Math.abs(hash) % OBJECTIVES.length];
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('dailychallenge')
        .setDescription('View and claim your Prestige VI+ Daily Challenge board bonus.'),

    async execute(interaction) {
        const [userDoc, guildSettings] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
            Guild.findOne({ guildId: interaction.guild.id }),
        ]);

        const rank = userDoc?.accountPrestige?.rank ?? 0;
        if (!hasUnlock(rank, 'daily_challenge')) {
            return interaction.reply({
                content: '📋 The Daily Challenge board unlocks at **Prestige VI**. Keep grinding!',
                flags: MessageFlags.Ephemeral,
            });
        }

        const currency = guildSettings?.economy?.currency ?? '💰';
        const dayKey = new Date().toISOString().slice(0, 10);
        const objective = pickObjective(interaction.user.id, dayKey);

        const lastClaim = userDoc.accountPrestige?.lastDailyChallengeAt;
        const onCooldown = lastClaim && (Date.now() - lastClaim.getTime()) < CLAIM_COOLDOWN_MS;

        if (onCooldown) {
            const nextAt = Math.floor((lastClaim.getTime() + CLAIM_COOLDOWN_MS) / 1000);
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📋 Daily Challenge Board')
                .setDescription(
                    `**Today's Objective:** ${objective.emoji} ${objective.text}\n\n` +
                    `✅ Already claimed. Next bonus available <t:${nextAt}:R>.`
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const coinReward = BASE_REWARD_COINS + rank * 1_000;
        const xpReward    = BASE_REWARD_XP + rank * 50;

        const updated = await User.findOneAndUpdate(
            {
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                $or: [
                    { 'accountPrestige.lastDailyChallengeAt': null },
                    { 'accountPrestige.lastDailyChallengeAt': { $lt: new Date(Date.now() - CLAIM_COOLDOWN_MS) } },
                ],
            },
            {
                $inc: { balance: coinReward, xp: xpReward },
                $set: { 'accountPrestige.lastDailyChallengeAt': new Date() },
            },
            { new: true }
        );

        if (!updated) {
            return interaction.reply({
                content: 'You already claimed today\'s Daily Challenge bonus.',
                flags: MessageFlags.Ephemeral,
            });
        }

        logTransaction({
            userId: interaction.user.id,
            guildId: interaction.guild.id,
            type: 'daily_challenge_board',
            amount: coinReward,
            balance: updated.balance,
            note: `prestige ${rank} daily challenge board claim`,
        });

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('📋 Daily Challenge Board — Claimed!')
            .setDescription(
                `**Today's Objective:** ${objective.emoji} ${objective.text}\n\n` +
                `💰 **+${coinReward.toLocaleString()} ${currency}**\n` +
                `⭐ **+${xpReward.toLocaleString()} XP**\n\n` +
                `Balance: ${currency}${updated.balance.toLocaleString()}`
            )
            .setFooter({ text: 'Resets every 24h · Prestige VI+ exclusive' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    },
};
