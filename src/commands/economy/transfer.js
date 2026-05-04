const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Transfer coins to another user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to transfer coins to')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Amount of coins to transfer')
                .setRequired(true)
                .setMinValue(1)),
    async execute(interaction) {
        const recipient = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        if (recipient.bot) {
            return interaction.reply({ content: 'You cannot transfer coins to bots!', ephemeral: true });
        }

        if (recipient.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot transfer coins to yourself!', ephemeral: true });
        }

        try {
            let sender = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            let receiverUser = await User.findOne({ userId: recipient.id, guildId: interaction.guild.id });

            if (!sender) {
                sender = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
            }

            if (!receiverUser) {
                receiverUser = await User.create({ userId: recipient.id, guildId: interaction.guild.id });
            }

            if (sender.balance < amount) {
                return interaction.reply({ content: `You don't have enough coins! Your balance: ${sender.balance}`, ephemeral: true });
            }

            sender.balance -= amount;
            receiverUser.balance += amount;

            await sender.save();
            await receiverUser.save();

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Transfer Successful')
                .setDescription(`You transferred **${amount}** coins to ${recipient}`)
                .addFields(
                    { name: 'Your New Balance', value: `${sender.balance.toLocaleString()} coins` }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Transfer error:', error);
            await interaction.reply({ content: 'Failed to transfer coins.', ephemeral: true });
        }
    }
};