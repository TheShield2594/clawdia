const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');
const { MAX_COMBINED_MULTIPLIER, clampMultiplier } = require('../../config/economy');
const { generateDailyChallenge } = require('../../utils/dailyChallenge');

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
                return interaction.reply({
                    content: "You've already claimed your daily reward! Try again later.",
                    ephemeral: true
                });
            }

            logTransaction({
                userId: interaction.user.id,
                guildId: interaction.guild.id,
                type: 'daily',
                amount: actualAmount,
                balance: updated.balance,
                note: `streak ${user.streak?.current ?? 0}, mult ${combined.toFixed(2)}${capActive ? ' (capped)' : ''}`
            });

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

            const challenge = generateDailyChallenge();
            embed.addFields({ name: '🎯 Bonus Challenge', value: `${challenge.description}\n*Answer correctly for a **+50% bonus** on your daily reward!*` });

            const reply = await interaction.reply({ embeds: [embed], components: [challenge.row], fetchReply: true });

            let activateTimer = null;
            if (challenge.type === 'react_fast' && challenge.activeRow) {
                activateTimer = setTimeout(() => {
                    interaction.editReply({ components: [challenge.activeRow] }).catch(() => {});
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
            } catch {
                if (activateTimer) clearTimeout(activateTimer);
                embed.spliceFields(0, embed.data.fields.length,
                    { name: 'New Balance', value: `${updated.balance.toLocaleString()} coins` },
                    { name: '🎯 Bonus Challenge', value: '⏱️ Time\'s up! No bonus this time — your daily reward is still yours.' },
                );
                await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            }
        } catch (error) {
            console.error('Daily error:', error);
            await interaction.reply({ content: 'Failed to claim daily reward.', ephemeral: true });
        }
    }
};
