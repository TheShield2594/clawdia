'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { MINE_QUEST_TEMPLATES } = require('../../data/mineData');
const { ensureMineData, assignDailyMineQuests, applyXp, getLevelData } = require('../../services/mineService');

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('minequests')
        .setDescription('View and claim your daily mine quests')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('See your active daily mine quests'))
        .addSubcommand(sub =>
            sub.setName('claim')
                .setDescription('Claim rewards for a completed quest')
                .addStringOption(o =>
                    o.setName('quest')
                        .setDescription('Quest to claim')
                        .setRequired(true)
                        .addChoices(...MINE_QUEST_TEMPLATES.map(t => ({ name: t.name, value: t.id }))))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureMineData(user);
        assignDailyMineQuests(user);

        const now = Date.now();

        // ── VIEW ───────────────────────────────────────────────────────────
        if (sub === 'view') {
            const mineQuests = user.quests.filter(q =>
                q.questId.startsWith('mq_') && q.expiresAt?.getTime() > now
            );

            if (!mineQuests.length) {
                const embed = new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle('📋 Daily Mine Quests')
                    .setDescription('No active quests right now.\nUse `/mine` to start mining — quests will be assigned automatically!')
                    .setFooter({ text: 'Quests are assigned in batches of 3 and last 24 hours' });
                return interaction.reply({ embeds: [embed] });
            }

            if (user.isModified()) {
                await user.save().catch(e => console.error('[minequests] save error:', e));
            }

            const lines = mineQuests.map(q => {
                const template = MINE_QUEST_TEMPLATES.find(t => t.id === q.questId);
                if (!template) return null;

                const isClaimed  = q.progress === -1;
                const isComplete = !!q.completedAt && !isClaimed;
                const progress   = isClaimed ? template.target : Math.min(q.progress, template.target);
                const bar        = buildProgressBar(progress, template.target);
                const timeLeft   = formatExpiry(q.expiresAt.getTime() - now);
                const rewardStr  = `${currency}${template.reward.coins.toLocaleString()} · ${template.reward.xp} Miner XP`;

                let statusLine;
                if (isClaimed)       statusLine = '✅ **Claimed**';
                else if (isComplete) statusLine = '🎁 **Ready to claim!** — Use `/minequests claim`';
                else                 statusLine = `${bar} ${progress}/${template.target}`;

                return [
                    `${template.emoji} **${template.name}**`,
                    `> ${template.description}`,
                    `> ${statusLine}`,
                    `> Reward: ${rewardStr} · Expires: ${timeLeft}`
                ].join('\n');
            }).filter(Boolean);

            const readyCount = mineQuests.filter(q => q.completedAt && q.progress !== -1).length;

            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('📋 Daily Mine Quests')
                .setDescription(lines.join('\n\n'))
                .setTimestamp();

            embed.setFooter({ text: readyCount > 0
                ? `${readyCount} quest(s) ready to claim! Use /minequests claim`
                : 'Complete quests by mining • Claim rewards with /minequests claim' });

            return interaction.reply({ embeds: [embed] });
        }

        // ── CLAIM ──────────────────────────────────────────────────────────
        if (sub === 'claim') {
            const questId  = interaction.options.getString('quest');
            const template = MINE_QUEST_TEMPLATES.find(t => t.id === questId);

            if (!template) {
                return interaction.reply({ content: 'Unknown quest.', ephemeral: true });
            }

            const questEntry = user.quests.find(q =>
                q.questId === questId &&
                q.expiresAt?.getTime() > now
            );

            if (!questEntry) {
                return interaction.reply({
                    content: `You don't have an active **${template.name}** quest. Go mining to get quests assigned!`,
                    ephemeral: true
                });
            }

            if (questEntry.progress === -1) {
                return interaction.reply({
                    content: `You already claimed **${template.name}**. Complete your other quests or wait for new ones!`,
                    ephemeral: true
                });
            }

            if (!questEntry.completedAt) {
                const progress = Math.min(questEntry.progress, template.target);
                return interaction.reply({
                    content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep mining!`,
                    ephemeral: true
                });
            }

            user.balance += template.reward.coins;
            const lvResult = applyXp(user, template.reward.xp);

            questEntry.progress = -1;
            user.markModified('quests');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${template.emoji} Quest Complete — ${template.name}!`)
                .setDescription(template.description)
                .addFields(
                    { name: `${currency} Coins`,  value: `+${template.reward.coins.toLocaleString()}`,  inline: true },
                    { name: '⭐ Miner XP',         value: `+${template.reward.xp}`,                     inline: true },
                    { name: '💳 New Balance',       value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                );

            if (lvResult.leveledUp) {
                const ld = getLevelData(lvResult.newLevel);
                embed.addFields({
                    name:  '⬆️ Level Up!',
                    value: `Miner Level **${lvResult.oldLevel}** → **${lvResult.newLevel}** (${ld.title})`,
                    inline: false
                });
            }

            const remaining = user.quests.filter(q =>
                q.questId.startsWith('mq_') &&
                q.expiresAt?.getTime() > now &&
                q.progress !== -1
            ).length;

            embed.setFooter({ text: remaining > 0
                ? `${remaining} quest(s) remaining — use /minequests view`
                : 'All quests claimed! Mine again to receive a fresh set.' });
            embed.setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
};

function buildProgressBar(current, target, length = 10) {
    const filled = Math.min(length, Math.round((current / target) * length));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

function formatExpiry(ms) {
    if (ms <= 0) return 'expired';
    const hrs  = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
}
