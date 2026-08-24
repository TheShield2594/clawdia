'use strict';

// /hunt quests — the daily quest board and claiming a finished one.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureHuntData, assignDailyHuntQuests, applyXp, getLevelData } = require('../../../services/huntService');
const { HUNT_QUEST_TEMPLATES } = require('../../../data/huntData');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const { buildProgressBar, formatExpiry } = require('./embeds');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTS (was /huntquests)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeQuests(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
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
    ensureHuntData(user);
    assignDailyHuntQuests(user);

    const now = Date.now();

    if (sub === 'view') {
        const huntQuests = user.quests.filter(q =>
            q.questId.startsWith('hq_') && q.expiresAt?.getTime() > now
        );

        if (!huntQuests.length) {
            const embed = new EmbedBuilder()
                .setColor('#e67e22')
                .setTitle('📋 Daily Hunt Quests')
                .setDescription('No active quests right now.\nUse `/hunt start` to go on a hunt — quests will be assigned automatically!')
                .setFooter({ text: 'Quests are assigned in batches of 3 and last 24 hours' });
            return interaction.reply({ embeds: [embed] });
        }

        if (user.isModified()) {
            await user.save().catch(e => console.error('[huntquests] save error:', e));
        }

        const lines = huntQuests.map(q => {
            const template = HUNT_QUEST_TEMPLATES.find(t => t.id === q.questId);
            if (!template) return null;

            const isClaimed   = q.progress === -1;
            const isComplete  = !!q.completedAt && !isClaimed;
            const progress    = isClaimed ? template.target : Math.min(q.progress, template.target);
            const bar         = buildProgressBar(progress, template.target);
            const timeLeft    = formatExpiry(q.expiresAt.getTime() - now);
            const rewardStr   = `${currency}${template.reward.coins.toLocaleString()} · ${template.reward.xp} Hunter XP`;

            let statusLine;
            if (isClaimed)       statusLine = '✅ **Claimed**';
            else if (isComplete) statusLine = '🎁 **Ready to claim!** — Use `/hunt quests claim`';
            else                 statusLine = `${bar} ${progress}/${template.target}`;

            return [
                `${template.emoji} **${template.name}**`,
                `> ${template.description}`,
                `> ${statusLine}`,
                `> Reward: ${rewardStr} · Expires: ${timeLeft}`
            ].join('\n');
        }).filter(Boolean);

        const readyCount = huntQuests.filter(q => q.completedAt && q.progress !== -1).length;

        const embed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle('📋 Daily Hunt Quests')
            .setDescription(lines.join('\n\n'))
            .setTimestamp();

        if (readyCount > 0) {
            embed.setFooter({ text: `${readyCount} quest(s) ready to claim! Use /hunt quests claim` });
        } else {
            embed.setFooter({ text: 'Complete quests by hunting • Claim rewards with /hunt quests claim' });
        }

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'claim') {
        const questId  = interaction.options.getString('quest');
        const template = HUNT_QUEST_TEMPLATES.find(t => t.id === questId);

        if (!template) {
            return interaction.reply({ content: 'Unknown quest.', flags: MessageFlags.Ephemeral });
        }

        const questEntry = user.quests.find(q =>
            q.questId === questId &&
            q.expiresAt?.getTime() > now
        );

        if (!questEntry) {
            return interaction.reply({
                content: `You don't have an active **${template.name}** quest. Go hunting to get quests assigned!`,
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
                content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep hunting!`,
                flags: MessageFlags.Ephemeral
            });
        }

        // The claim's coins are applied as an `$inc` after the save. `save()`
        // writes `balance` as an absolute `$set`, which would put back the value
        // read at the top of the command and erase anything paid since.
        const balanceAtLoad = user.balance ?? 0;
        user.balance += template.reward.coins;
        const lvResult = applyXp(user, template.reward.xp);

        questEntry.progress = -1;
        user.markModified('quests');
        try {
            await saveWithBalanceDelta(User, user, balanceAtLoad, {
                service: 'hunt',
                jobName: 'questClaimCoins',
                guildId: interaction.guild.id,
            });
        } catch (err) {
            // The document was loaded at the top of the command and the message,
            // reaction and command handlers all write to it, so a version
            // conflict here is ordinary. Nothing was claimed; say so rather than
            // leaving the interaction unanswered.
            console.error('[huntquests claim] save error:', err);
            return interaction.reply({ content: 'Something went wrong claiming that quest. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle(`${template.emoji} Quest Complete — ${template.name}!`)
            .setDescription(template.description)
            .addFields(
                { name: `${currency} Coins`,  value: `+${template.reward.coins.toLocaleString()}`,           inline: true },
                { name: '⭐ Hunter XP',        value: `+${template.reward.xp}`,                               inline: true },
                { name: '💳 New Balance',      value: `${currency}${user.balance.toLocaleString()}`,          inline: true }
            );

        if (lvResult.leveledUp) {
            const ld = getLevelData(lvResult.newLevel);
            embed.addFields({
                name:  '⬆️ Level Up!',
                value: `Hunter Level **${lvResult.oldLevel}** → **${lvResult.newLevel}** (${ld.title})`,
                inline: false
            });
        }

        const liveQuests = user.quests.filter(q =>
            q.questId.startsWith('hq_') && q.expiresAt?.getTime() > now
        );
        const remaining = liveQuests.filter(q => q.progress !== -1).length;

        // A fresh batch is only assigned once the current one has expired — see the
        // guard in assign*Quests. Say when that is rather than implying that playing
        // again brings one sooner, which is what this footer used to promise.
        const nextSetIn = liveQuests.length
            ? formatExpiry(Math.min(...liveQuests.map(q => q.expiresAt.getTime())) - now)
            : null;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /hunt quests view`
            : `All quests claimed! A fresh set arrives in ${nextSetIn ?? 'a few hours'}.` });
        embed.setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

module.exports = {
    executeQuests,
};
