const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your or another user\'s balance')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check balance for')
                .setRequired(false)),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;

        try {
            let user = await User.findOne({ userId: targetUser.id, guildId: interaction.guild.id });

            if (!user) {
                user = await User.create({
                    userId: targetUser.id,
                    guildId: interaction.guild.id
                });
            }

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle(`${targetUser.username}'s Balance`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '💰 Wallet', value: `${user.balance.toLocaleString()} coins`, inline: true },
                    { name: '🏦 Bank', value: `${user.bank.toLocaleString()} coins`, inline: true },
                    { name: '💎 Total', value: `${(user.balance + user.bank).toLocaleString()} coins`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Balance error:', error);
            await interaction.reply({ content: 'Failed to fetch balance.', ephemeral: true });
        }
    }
};