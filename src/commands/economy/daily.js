const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');
const { MAX_COMBINED_MULTIPLIER, clampMultiplier } = require('../../config/economy');
const { generateDailyChallenge } = require('../../utils/dailyChallenge');
const { DROP_TABLE, RARE_DROP_TABLE, DROP_MILESTONES, DROP_BASE_CHANCE, weightedRandom } = require('../../data/dailyDropTable');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim your daily coin reward (amount set by server admins, default 100). Resets every 24 hours.'),
    cooldown: 5,
    async execute(interaction) {
        try {
            const [user, guildSettings] = await Promise.all([
                User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
                    { upsert: true, new: true }
                ),
                Guild.findOne({ guildId: interaction.guild.id })
            ]);

            const now = Date.now();
            const dailyCooldown = 86400000;

            if (user.lastDaily && now - user.lastDaily.getTime() < dailyCooldown) {
                const timeLeft = dailyCooldown - (now - user.lastDaily.getTime());
                const hours = Math.floor(timeLeft / 3600000);
                const minutes = Math.floor((timeLeft % 3600000) / 60000);

                return interaction.reply({
                    content: `You've already claimed your daily reward! Come back in ${hours}h ${minutes}m.`,
                    ephemeral: true
                });
            }

            // ── Streak Freeze Restore Prompt ─────────────────────────────────────
            const pendingRestore = user.streak?.pendingRestore ?? 0;
            const freezesAvailable = user.streak?.freezes ?? 0;
            let usedFollowUp = false;

            if (pendingRestore > 0 && freezesAvailable > 0) {
                const restoreRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('freeze_restore')
                        .setLabel('✅ Restore Streak')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('freeze_skip')
                        .setLabel('❌ Start Fresh')
                        .setStyle(ButtonStyle.Secondary),
                );

                const freezeEmbed = new EmbedBuilder()
                    .setColor('#ff4444')
                    .setTitle('💔 Your streak was broken!')
                    .setDescription(
                        `Your **${pendingRestore}-day streak** was broken!\n\n` +
                        `You have **${freezesAvailable}** Streak Freeze${freezesAvailable !== 1 ? 's' : ''} available.\n` +
                        `Would you like to use one to restore your streak?`
                    )
                    .addFields({ name: '❄️ Streak Freezes', value: `${freezesAvailable} banked`, inline: true })
                    .setTimestamp();

                const promptReply = await interaction.reply({ embeds: [freezeEmbed], components: [restoreRow], fetchReply: true });
                usedFollowUp = true;

                try {
                    const resp = await promptReply.awaitMessageComponent({
                        time: 30000,
                        filter: i => i.user.id === interaction.user.id,
                    });

                    if (resp.customId === 'freeze_restore') {
                        await User.findOneAndUpdate(
                            { userId: interaction.user.id, guildId: interaction.guild.id },
                            {
                                $set: { 'streak.current': pendingRestore, 'streak.pendingRestore': 0 },
                                $inc: { 'streak.freezes': -1 }
                            }
                        );
                        user.streak.current = pendingRestore;
                        user.streak.freezes = freezesAvailable - 1;
                        user.streak.pendingRestore = 0;

                        await resp.update({
                            embeds: [
                                EmbedBuilder.from(freezeEmbed)
                                    .setColor('#00ff00')
                                    .setDescription(
                                        `✅ Streak restored! Your **${pendingRestore}-day streak** continues!\n\n` +
                                        `1 Streak Freeze consumed. **${user.streak.freezes}** remaining.`
                                    )
                                    .setFields({ name: '❄️ Streak Freezes', value: `${user.streak.freezes} remaining`, inline: true })
                            ],
                            components: [],
                        });
                    } else {
                        await User.findOneAndUpdate(
                            { userId: interaction.user.id, guildId: interaction.guild.id },
                            { $set: { 'streak.pendingRestore': 0 } }
                        );
                        user.streak.pendingRestore = 0;

                        await resp.update({
                            embeds: [
                                EmbedBuilder.from(freezeEmbed)
                                    .setColor('#888888')
                                    .setDescription('Starting fresh! Build that streak back up 💪')
                                    .setFields()
                            ],
                            components: [],
                        });
                    }
                } catch {
                    // Timeout — clear pending, continue with daily
                    await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $set: { 'streak.pendingRestore': 0 } }
                    );
                    user.streak.pendingRestore = 0;
                    await interaction.editReply({ components: [] }).catch(() => {});
                }
            }
            // ─────────────────────────────────────────────────────────────────────

            const dailyAmount  = guildSettings?.economy?.dailyAmount ?? 100;
            const streakMult   = getStreakMultiplier(user.streak?.current ?? 0);
            const coinMult     = getCoinMultiplier(user);
            const serverMult   = getServerCoinMultiplier(guildSettings);
            const rawCombined  = streakMult * coinMult * serverMult;
            const combined     = clampMultiplier(rawCombined);
            const actualAmount = Math.round(dailyAmount * combined);
            const capActive    = rawCombined > MAX_COMBINED_MULTIPLIER;

            // Atomic update — cooldown condition in query prevents double-credit on concurrent requests
            const updated = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    $or: [
                        { lastDaily: null },
                        { lastDaily: { $lt: new Date(now - dailyCooldown) } }
                    ]
                },
                {
                    $inc: { balance: actualAmount },
                    $set: { lastDaily: new Date(now) }
                },
                { new: true }
            );

            if (!updated) {
                const errorMsg = { content: "You've already claimed your daily reward! Try again later.", ephemeral: true };
                return usedFollowUp ? interaction.followUp(errorMsg) : interaction.reply(errorMsg);
            }

            logTransaction({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                type: 'daily',
                amount: actualAmount,
                balance: updated.balance,
                note: `streak ${user.streak?.current ?? 0}, mult ${combined.toFixed(2)}${capActive ? ' (capped)' : ''}`
            });

            // ── Item Drop Check ───────────────────────────────────────────────────
            const streakCurrent = user.streak?.current ?? 0;
            const claimedDropMilestones = new Set(user.streak?.claimedDropMilestones ?? []);
            const isMilestone = DROP_MILESTONES.includes(streakCurrent) && !claimedDropMilestones.has(streakCurrent);
            const rollDrop = isMilestone || Math.random() < DROP_BASE_CHANCE;

            let droppedItem = null;
            if (rollDrop) {
                droppedItem = weightedRandom(isMilestone ? RARE_DROP_TABLE : DROP_TABLE);

                const dropUpdate = {
                    $push: { inventory: { itemId: droppedItem.itemId, quantity: 1 } }
                };
                if (isMilestone) {
                    dropUpdate.$addToSet = { 'streak.claimedDropMilestones': streakCurrent };
                }
                await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id },
                    dropUpdate
                );

                logTransaction({
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    type: 'daily_drop',
                    amount: 0,
                    balance: updated.balance,
                    note: `${droppedItem.itemId}${isMilestone ? ` (streak milestone ${streakCurrent}d)` : ''}`
                });
            }
            // ─────────────────────────────────────────────────────────────────────

            const bonusLines = [];
            if (streakMult > 1.0) bonusLines.push(`🔥 **${streakMult}x streak bonus** applied!`);
            if (coinMult > 1.0)   bonusLines.push(`💰🚀 **${coinMult}x Coin Booster** active!`);
            if (serverMult > 1.0) bonusLines.push(`🌐 **${serverMult}x Server Boost** active!`);
            if (capActive)        bonusLines.push(`⚠️ Combined multiplier capped at **${MAX_COMBINED_MULTIPLIER}x**.`);
            const bonusLine = bonusLines.length ? `\n${bonusLines.join('\n')}` : '';

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Daily Reward Claimed!')
                .setDescription(`You received **${actualAmount.toLocaleString()}** coins!${bonusLine}`)
                .addFields(
                    { name: 'New Balance', value: `${updated.balance.toLocaleString()} coins` }
                )
                .setFooter({ text: 'Cooldown: 24h' })
                .setTimestamp();

            if (droppedItem) {
                const dropLabel = isMilestone ? `🎁 Milestone Drop! (${streakCurrent}-day streak)` : '🎁 Surprise Drop!';
                embed.addFields({
                    name: dropLabel,
                    value: `You found a ${droppedItem.emoji} **${droppedItem.name}** in today's reward!`
                });
            }

            const freezeCount = user.streak?.freezes ?? 0;
            if (freezeCount > 0) {
                embed.addFields({ name: '❄️ Streak Freezes', value: `${freezeCount} banked`, inline: true });
            }

            const challenge = generateDailyChallenge();
            embed.addFields({ name: '🎯 Bonus Challenge', value: `${challenge.description}\n*Answer correctly for a **+50% bonus** on your daily reward!*` });

            const sendOpts = { embeds: [embed], components: [challenge.row], fetchReply: true };
            const reply = usedFollowUp
                ? await interaction.followUp(sendOpts)
                : await interaction.reply(sendOpts);

            let activateTimer = null;
            if (challenge.type === 'react_fast' && challenge.activeRow) {
                activateTimer = setTimeout(() => {
                    reply.edit({ components: [challenge.activeRow] }).catch(() => {});
                }, challenge.activateDelay);
            }

            try {
                const response = await reply.awaitMessageComponent({
                    time: challenge.timeLimit,
                    filter: i => i.user.id === interaction.user.id,
                });
                if (activateTimer) clearTimeout(activateTimer);

                if (response.customId === challenge.correctId) {
                    const bonusAmount = Math.round(actualAmount * 0.5);
                    const bonusUpdated = await User.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id },
                        { $inc: { balance: bonusAmount } },
                        { new: true }
                    );
                    logTransaction({
                        userId: interaction.user.id,
                        guildId: interaction.guild.id,
                        type: 'daily_challenge_bonus',
                        amount: bonusAmount,
                        balance: bonusUpdated?.balance ?? updated.balance + bonusAmount,
                        note: `daily challenge bonus (${challenge.type})`,
                    });
                    embed.setColor('#ffd700');
                    embed.spliceFields(0, embed.data.fields.length,
                        { name: 'New Balance', value: `${(bonusUpdated?.balance ?? updated.balance + bonusAmount).toLocaleString()} coins` },
                        { name: '🎯 Bonus Challenge', value: `✅ Correct! You earned an extra **+${bonusAmount.toLocaleString()}** coins!` },
                    );
                    await response.update({ embeds: [embed], components: [] });
                } else {
                    embed.spliceFields(0, embed.data.fields.length,
                        { name: 'New Balance', value: `${updated.balance.toLocaleString()} coins` },
                        { name: '🎯 Bonus Challenge', value: '❌ Wrong answer! No bonus this time — your daily reward is still yours.' },
                    );
                    await response.update({ embeds: [embed], components: [] });
                }
            } catch (err) {
                if (activateTimer) clearTimeout(activateTimer);
                if (err.name === 'InteractionCollectorError') {
                    embed.spliceFields(0, embed.data.fields.length,
                        { name: 'New Balance', value: `${updated.balance.toLocaleString()} coins` },
                        { name: '🎯 Bonus Challenge', value: '⏱️ Time\'s up! No bonus this time — your daily reward is still yours.' },
                    );
                    await reply.edit({ embeds: [embed], components: [] }).catch(() => {});
                } else {
                    console.error('Daily challenge error:', err);
                    await reply.edit({ components: [] }).catch(() => {});
                }
            }
        } catch (error) {
            console.error('Daily error:', error);
            const errMsg = { content: 'Failed to claim daily reward.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errMsg).catch(() => {});
            } else {
                await interaction.reply(errMsg);
            }
        }
    }
};
