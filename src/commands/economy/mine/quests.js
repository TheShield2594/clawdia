'use strict';

// /mine quests — the daily quest board and claiming a finished one.

const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureMineData, assignDailyMineQuests, applyXp, getLevelData } = require('../../../services/mineService');
const { MINE_QUEST_TEMPLATES } = require('../../../data/mineData');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { buildProgressBar, formatExpiry } = require('./embeds');
const COLORS = require('../../../utils/embedColors');

// ─── QUESTS ───────────────────────────────────────────────────────────────────

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
    ensureMineData(user);
    assignDailyMineQuests(user);

    const now = Date.now();

    if (sub === 'view') {
        const mineQuests = user.quests.filter(q =>
            q.questId.startsWith('mq_') && q.expiresAt?.getTime() > now
        );

        if (!mineQuests.length) {
            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('📋 Daily Mine Quests')
                .setDescription('No active quests right now.\nUse `/mine dig` to start mining — quests will be assigned automatically!')
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
            else if (isComplete) statusLine = '🎁 **Ready to claim!** — Use `/mine quests claim`';
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
            ? `${readyCount} quest(s) ready to claim! Use /mine quests claim`
            : 'Complete quests by mining • Claim rewards with /mine quests claim' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'claim') {
        if (user.isModified()) {
            await user.save().catch(e => console.error('[minequests] pre-claim save error:', e));
        }

        const questId  = interaction.options.getString('quest');
        const template = MINE_QUEST_TEMPLATES.find(t => t.id === questId);

        if (!template) {
            return interaction.reply({ content: 'Unknown quest.', flags: MessageFlags.Ephemeral });
        }

        const questEntry = user.quests.find(q =>
            q.questId === questId &&
            q.expiresAt?.getTime() > now
        );

        if (!questEntry) {
            return interaction.reply({
                content: `You don't have an active **${template.name}** quest. Go mining to get quests assigned!`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (questEntry.progress === -1) {
            return interaction.reply({
                content: `You already claimed **${template.name}**. Complete your other quests or wait for new ones!`,
                flags: MessageFlags.Ephemeral
            });
        }

        if (!questEntry.completedAt) {
            const progress = Math.min(questEntry.progress, template.target);
            return interaction.reply({
                content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep mining!`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Same rule as everywhere else: the claim pays a delta, never a snapshot.
        const balanceAtLoad = user.balance ?? 0;
        user.balance += template.reward.coins;
        const lvResult = applyXp(user, template.reward.xp);

        questEntry.progress = -1;
        user.markModified('quests');
        try {
            await saveWithBalanceDelta(User, user, balanceAtLoad, {
                service: 'mine',
                jobName: 'questClaimCoins',
                guildId: interaction.guild.id,
            });
        } catch (err) {
            // Same reasoning as /hunt quests claim: a version conflict on this
            // document is ordinary, and an unanswered interaction is not.
            console.error('[minequests claim] save error:', err);
            return interaction.reply({ content: 'Something went wrong claiming that quest. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
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

        const liveQuests = user.quests.filter(q =>
            q.questId.startsWith('mq_') && q.expiresAt?.getTime() > now
        );
        const remaining = liveQuests.filter(q => q.progress !== -1).length;

        // A fresh batch is only assigned once the current one has expired — see the
        // guard in assign*Quests. Say when that is rather than implying that playing
        // again brings one sooner, which is what this footer used to promise.
        const nextSetIn = liveQuests.length
            ? formatExpiry(Math.min(...liveQuests.map(q => q.expiresAt.getTime())) - now)
            : null;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /mine quests view`
            : `All quests claimed! A fresh set arrives in ${nextSetIn ?? 'a few hours'}.` });
        embed.setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

module.exports = {
    handleQuests,
};
