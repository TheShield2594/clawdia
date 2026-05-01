const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deposit')
        .setDescription('Deposit coins into your bank')
        .addStringOption(o =>
            o.setName('amount')
                .setDescription('Amount to deposit (or "all")')
                .setRequired(true)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        const currency = guildSettings?.economy?.currency ?? '💰';

        const userData = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        const input = interaction.options.getString('amount').toLowerCase();
        const amount = input === 'all' ? userData.balance : parseInt(input, 10);

        if (isNaN(amount) || amount <= 0) {
            return interaction.reply({ content: 'Please enter a valid positive amount.', ephemeral: true });
        }

        if (amount > userData.balance) {
            return interaction.reply({
                content: `You only have ${currency}${userData.balance} in your wallet.`,
                ephemeral: true
            });
        }

        userData.balance -= amount;
        userData.bank += amount;

        try {
            await userData.save();
        } catch (err) {
            console.error('[deposit] save error:', err);
            return interaction.reply({ content: 'Failed to save your deposit. Please try again.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Deposit Successful')
            .addFields(
                { name: 'Deposited', value: `${currency}${amount}`, inline: true },
                { name: 'Wallet', value: `${currency}${userData.balance}`, inline: true },
                { name: 'Bank', value: `${currency}${userData.bank}`, inline: true }
            );

        await interaction.reply({ embeds: [embed] });
    }
};
