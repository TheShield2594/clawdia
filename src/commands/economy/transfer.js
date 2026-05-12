const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const { logTransaction } = require('../../utils/logTransaction');

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
                .setDescription('Coins to send (min: 1). Must not exceed your wallet balance.')
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
            // Atomically deduct from sender — only succeeds if they have enough balance.
            // Using findOneAndUpdate avoids a read-modify-write race condition where two
            // concurrent transfers could both pass the balance check and overdraft the wallet.
            const sender = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: amount } },
                { $inc: { balance: -amount } },
                { new: true }
            );

            if (!sender) {
                // Either the user doesn't exist yet or they lack sufficient balance.
                const existing = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                const currentBal = existing ? existing.balance : 0;
                return interaction.reply({
                    content: `You don't have enough coins! Your balance: ${currentBal.toLocaleString()} coins`,
                    ephemeral: true
                });
            }

            // Credit receiver; upsert in case they have no record yet.
            const receiver = await User.findOneAndUpdate(
                { userId: recipient.id, guildId: interaction.guild.id },
                { $inc: { balance: amount } },
                { upsert: true, new: true }
            );

            logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'transfer_send', amount: -amount, balance: sender.balance, relatedUserId: recipient.id });
            logTransaction({ userId: recipient.id, guildId: interaction.guild.id, type: 'transfer_receive', amount, balance: receiver.balance, relatedUserId: interaction.user.id });

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Transfer Successful')
                .setDescription(`You transferred **${amount.toLocaleString()}** coins to ${recipient}`)
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