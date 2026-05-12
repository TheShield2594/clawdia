const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { getStreakMultiplier } = require('../../utils/streakMultiplier');
const { getCoinMultiplier, getServerCoinMultiplier } = require('../../services/effectsService');
const { logTransaction } = require('../../utils/logTransaction');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim your daily coin reward (amount set by server admins, default 100). Resets every 24 hours.'),
    cooldown: 5,
    async execute(interaction) {
        try {
            let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

            if (!user) {
                user = await User.create({
                    userId: interaction.user.id,
                    guildId: interaction.guild.id
                });
            }

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
            const actualAmount = Math.round(dailyAmount * streakMult * coinMult * serverMult);
            user.balance += actualAmount;
            user.lastDaily = new Date();
            await user.save();

            logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'daily', amount: actualAmount, balance: user.balance, note: `streak ${user.streak?.current ?? 0}x, mult ${(streakMult * coinMult * serverMult).toFixed(2)}` });

            const bonusLines = [];
            if (streakMult > 1.0) bonusLines.push(`🔥 **${streakMult}x streak bonus** applied!`);
            if (coinMult > 1.0)   bonusLines.push(`💰🚀 **${coinMult}x Coin Booster** active!`);
            if (serverMult > 1.0) bonusLines.push(`🌐 **${serverMult}x Server Boost** active!`);
            const bonusLine = bonusLines.length ? `\n${bonusLines.join('\n')}` : '';

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Daily Reward Claimed!')
                .setDescription(`You received **${actualAmount.toLocaleString()}** coins!${bonusLine}`)
                .addFields(
                    { name: 'New Balance', value: `${user.balance.toLocaleString()} coins` }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Daily error:', error);
            await interaction.reply({ content: 'Failed to claim daily reward.', ephemeral: true });
        }
    }
};