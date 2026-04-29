const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim your daily coins'),
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

            const dailyAmount = guildSettings?.economy.dailyAmount || 100;
            user.balance += dailyAmount;
            user.lastDaily = new Date();
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Daily Reward Claimed!')
                .setDescription(`You received **${dailyAmount}** coins!`)
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