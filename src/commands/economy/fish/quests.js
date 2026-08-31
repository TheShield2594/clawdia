'use strict';

// /fish quests — the daily quest board and claiming a finished one.

const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureFishingData, assignDailyFishQuests, formatMs, applyXp, getLevelData } = require('../../../services/fishService');
const { FISH_QUEST_TEMPLATES } = require('../../../data/fishData');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { buildQuestProgressBar } = require('./embeds');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleQuests(interaction, sub) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);
    assignDailyFishQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[fishquests] pre-save error:', e));
    }

    if (sub === 'view') return showQuests(interaction, user, currency);
    return claimQuest(interaction, user, currency);
}

async function showQuests(interaction, user, currency) {
    const now         = Date.now();
    const fishQuests  = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    if (!fishQuests.length) {
        return interaction.reply({ content: 'No fishing quests assigned yet. Use `/fish cast` to start fishing!', flags: MessageFlags.Ephemeral });
    }

    const lines = fishQuests.map((q, i) => {
        const template  = FISH_QUEST_TEMPLATES.find(t => t.id === q.questId);
        if (!template) return null;

        const isClaimed   = q.progress === -1;
        const isCompleted = q.completedAt && !isClaimed;
        const progress    = isClaimed ? template.target : Math.min(q.progress, template.target);
        const bar         = buildQuestProgressBar(progress, template.target, 10);
        const rewardStr   = `${currency}${template.reward.coins} + ${template.reward.xp} XP`;
        const expiresIn   = formatMs(q.expiresAt.getTime() - now);

        const statusIcon  = isClaimed ? '✅' : isCompleted ? '🎁' : '⏳';
        return [
            `**${i + 1}.** ${template.emoji} **${template.name}** ${statusIcon}`,
            `   ${template.description}`,
            `   ${bar} ${progress}/${template.target}`,
            `   Reward: ${rewardStr}${isClaimed ? ' (claimed)' : isCompleted ? ' — **/fish quests claim ' + (i + 1) + '**' : ''}`,
            `   Expires in: ${expiresIn}`
        ].join('\n');
    }).filter(Boolean);

    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`🎣 ${interaction.user.username}'s Daily Fishing Quests`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Quests refresh every 24h after all are completed or claimed' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function claimQuest(interaction, user, currency) {
    const now        = Date.now();
    const number     = interaction.options.getInteger('number');
    const fishQuests = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    const questEntry = fishQuests[number - 1];
    if (!questEntry) {
        return interaction.reply({ content: `No quest at slot #${number}. Use \`/fish quests view\` to see your quests.`, flags: MessageFlags.Ephemeral });
    }

    const template = FISH_QUEST_TEMPLATES.find(t => t.id === questEntry.questId);
    if (!template) {
        return interaction.reply({ content: 'Quest data not found.', flags: MessageFlags.Ephemeral });
    }

    if (questEntry.progress === -1) {
        return interaction.reply({ content: `**${template.name}** has already been claimed.`, flags: MessageFlags.Ephemeral });
    }
    if (!questEntry.completedAt) {
        const progress = Math.min(questEntry.progress, template.target);
        return interaction.reply({
            content: `**${template.name}** is not complete yet. Progress: **${progress}/${template.target}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Same rule as the cast itself: the claim pays a delta, never a snapshot of
    // the balance this command happened to read.
    const balanceAtLoad = user.balance ?? 0;
    const oldLevel      = user.fishing.level;
    user.balance       += template.reward.coins;
    questEntry.progress = -1;

    const lvResult = applyXp(user, template.reward.xp);
    const leveledUp = lvResult.leveledUp;

    user.markModified('quests');
    user.markModified('fishing');

    try {
        await saveWithBalanceDelta(User, user, balanceAtLoad, {
            service: 'fish',
            jobName: 'questClaimCoins',
            guildId: interaction.guild.id,
        });
    } catch (err) {
        console.error('[fishquests claim] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle(`${template.emoji} Quest Reward Claimed!`)
        .setDescription(`**${template.name}** completed!`)
        .addFields(
            { name: 'Coins Earned', value: `${currency}${template.reward.coins.toLocaleString()}`, inline: true },
            { name: 'XP Earned',   value: `+${template.reward.xp} Fishing XP`,                   inline: true },
            { name: 'Balance',     value: `${currency}${user.balance.toLocaleString()}`,           inline: true }
        )
        .setTimestamp();

    if (leveledUp) {
        const ld = getLevelData(lvResult.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Fisher Level **${oldLevel}** → **${lvResult.newLevel}** (${ld.title})`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    claimQuest,
    handleQuests,
    showQuests,
};
