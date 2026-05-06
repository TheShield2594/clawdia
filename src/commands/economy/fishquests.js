'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { FISH_QUEST_TEMPLATES } = require('../../data/fishData');
const { ensureFishingData, assignDailyFishQuests, formatMs, applyXp, getLevelData } = require('../../services/fishService');

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishquests')
        .setDescription('View and claim your daily fishing quests')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View your active daily fishing quests'))
        .addSubcommand(sub =>
            sub.setName('claim')
                .setDescription('Claim rewards for a completed quest')
                .addIntegerOption(o =>
                    o.setName('number')
                        .setDescription('Quest number to claim')
                        .setMinValue(1)
                        .setRequired(true))),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';
        const sub      = interaction.options.getSubcommand();

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureFishingData(user);
        assignDailyFishQuests(user);

        if (user.isModified()) {
            await user.save().catch(e => console.error('[fishquests] pre-save error:', e));
        }

        if (sub === 'view') return showQuests(interaction, user, currency);
        return claimQuest(interaction, user, currency);
    }
};

// ─── VIEW ─────────────────────────────────────────────────────────────────────

async function showQuests(interaction, user, currency) {
    const now         = Date.now();
    const fishQuests  = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    if (!fishQuests.length) {
        return interaction.reply({ content: 'No fishing quests assigned yet. Use `/fish` to start fishing!', ephemeral: true });
    }

    const lines = fishQuests.map((q, i) => {
        const template  = FISH_QUEST_TEMPLATES.find(t => t.id === q.questId);
        if (!template) return null;

        const isClaimed   = q.progress === -1;
        const isCompleted = q.completedAt && !isClaimed;
        const progress    = isClaimed ? template.target : Math.min(q.progress, template.target);
        const bar         = buildProgressBar(progress, template.target, 10);
        const rewardStr   = `${currency}${template.reward.coins} + ${template.reward.xp} XP`;
        const expiresIn   = formatMs(q.expiresAt.getTime() - now);

        const statusIcon  = isClaimed ? '✅' : isCompleted ? '🎁' : '⏳';
        return [
            `**${i + 1}.** ${template.emoji} **${template.name}** ${statusIcon}`,
            `   ${template.description}`,
            `   ${bar} ${progress}/${template.target}`,
            `   Reward: ${rewardStr}${isClaimed ? ' (claimed)' : isCompleted ? ' — **/fishquests claim ' + (i + 1) + '**' : ''}`,
            `   Expires in: ${expiresIn}`
        ].join('\n');
    }).filter(Boolean);

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎣 ${interaction.user.username}'s Daily Fishing Quests`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Quests refresh every 24h after all are completed or claimed' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── CLAIM ────────────────────────────────────────────────────────────────────

async function claimQuest(interaction, user, currency) {
    const now        = Date.now();
    const number     = interaction.options.getInteger('number');
    const fishQuests = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    const questEntry = fishQuests[number - 1];
    if (!questEntry) {
        return interaction.reply({ content: `No quest at slot #${number}. Use \`/fishquests view\` to see your quests.`, ephemeral: true });
    }

    const template = FISH_QUEST_TEMPLATES.find(t => t.id === questEntry.questId);
    if (!template) {
        return interaction.reply({ content: 'Quest data not found.', ephemeral: true });
    }

    if (questEntry.progress === -1) {
        return interaction.reply({ content: `**${template.name}** has already been claimed.`, ephemeral: true });
    }
    if (!questEntry.completedAt) {
        const progress = Math.min(questEntry.progress, template.target);
        return interaction.reply({
            content: `**${template.name}** is not complete yet. Progress: **${progress}/${template.target}**.`,
            ephemeral: true
        });
    }

    // Grant rewards
    const oldLevel      = user.fishing.level;
    user.balance       += template.reward.coins;
    questEntry.progress = -1; // mark claimed

    // applyXp adds XP, recalculates level, and marks fishing modified
    const lvResult = applyXp(user, template.reward.xp);
    const leveledUp = lvResult.leveledUp;

    user.markModified('quests');
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishquests claim] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
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

function buildProgressBar(current, total, length) {
    const filled = Math.min(length, Math.max(0, Math.round((current / Math.max(1, total)) * length)));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}
