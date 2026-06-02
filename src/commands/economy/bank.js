const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { logTransaction } = require('../../utils/logTransaction');

async function getCurrency(guildId) {
    const guildSettings = await Guild.findOne({ guildId });
    return guildSettings?.economy?.currency ?? '💰';
}

async function handleDeposit(interaction) {
    const currency = await getCurrency(interaction.guild.id);

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
        console.error('[bank deposit] save error:', err);
        return interaction.reply({ content: 'Failed to save your deposit. Please try again.', ephemeral: true });
    }

    logTransaction({
        userId: interaction.user.id, guildId: interaction.guild.id, type: 'deposit',
        amount: -amount, balance: userData.balance, bank: userData.bank,
        note: `Deposited ${amount} to bank`
    });

    const isLarge = amount >= 10000;
    const depositTitle = isLarge ? '💼 Vault Secured' : '🏦 Deposit Successful';
    const depositDesc = isLarge
        ? `💼 Safely secured. **${amount.toLocaleString()} coins** locked in your vault.`
        : null;

    const depositEmbed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle(depositTitle)
        .addFields(
            { name: 'Deposited', value: `${currency}${amount.toLocaleString()}`, inline: true },
            { name: 'Wallet', value: `${currency}${userData.balance.toLocaleString()}`, inline: true },
            { name: 'Bank', value: `${currency}${userData.bank.toLocaleString()}`, inline: true }
        );

    if (depositDesc) depositEmbed.setDescription(depositDesc);

    await interaction.reply({ embeds: [depositEmbed] });
}

async function handleWithdraw(interaction) {
    const currency = await getCurrency(interaction.guild.id);

    const userData = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );

    const input = interaction.options.getString('amount').toLowerCase();
    const amount = input === 'all' ? userData.bank : parseInt(input, 10);

    if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: 'Please enter a valid positive amount.', ephemeral: true });
    }
    if (amount > userData.bank) {
        return interaction.reply({
            content: `You only have ${currency}${userData.bank} in your bank.`,
            ephemeral: true
        });
    }

    userData.bank -= amount;
    userData.balance += amount;

    try {
        await userData.save();
    } catch (err) {
        console.error('[bank withdraw] save error:', err);
        return interaction.reply({ content: 'Failed to save your withdrawal. Please try again.', ephemeral: true });
    }

    logTransaction({
        userId: interaction.user.id, guildId: interaction.guild.id, type: 'withdraw',
        amount, balance: userData.balance, bank: userData.bank,
        note: `Withdrew ${amount} from bank`
    });

    const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('Withdrawal Successful')
        .addFields(
            { name: 'Withdrawn', value: `${currency}${amount}`, inline: true },
            { name: 'Wallet', value: `${currency}${userData.balance}`, inline: true },
            { name: 'Bank', value: `${currency}${userData.bank}`, inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

async function handleTransfer(interaction) {
    const recipient = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (recipient.bot) {
        return interaction.reply({ content: 'You cannot transfer coins to bots!', ephemeral: true });
    }
    if (recipient.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot transfer coins to yourself!', ephemeral: true });
    }

    // Standalone MongoDB doesn't support multi-doc transactions; use atomic $inc
    // to debit only if the sender has the funds, then credit the receiver.
    try {
        const sender = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );

        if (!sender) {
            const existing = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            const currentBal = existing ? existing.balance : 0;
            return interaction.reply({
                content: `You don't have enough coins! Your balance: ${currentBal.toLocaleString()} coins`,
                ephemeral: true
            });
        }

        const receiver = await User.findOneAndUpdate(
            { userId: recipient.id, guildId: interaction.guild.id },
            { $inc: { balance: amount }, $setOnInsert: { userId: recipient.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );

        logTransaction({
            userId: interaction.user.id, guildId: interaction.guild.id, type: 'transfer_send',
            amount: -amount, balance: sender.balance, relatedUserId: recipient.id
        });
        logTransaction({
            userId: recipient.id, guildId: interaction.guild.id, type: 'transfer_receive',
            amount, balance: receiver.balance, relatedUserId: interaction.user.id
        });

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Transfer Successful')
            .setDescription(`You transferred **${amount.toLocaleString()}** coins to ${recipient}`)
            .addFields({ name: 'Your New Balance', value: `${sender.balance.toLocaleString()} coins` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        console.error('Transfer error:', error);
        await interaction.reply({ content: 'Failed to transfer coins.', ephemeral: true }).catch(() => {});
    }
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('bank')
        .setDescription('Manage your bank: deposit, withdraw, or transfer coins')
        .addSubcommand(sub =>
            sub.setName('deposit')
                .setDescription('Deposit coins from your wallet into your bank')
                .addStringOption(o =>
                    o.setName('amount').setDescription('Amount to deposit (or "all")').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('withdraw')
                .setDescription('Withdraw coins from your bank to your wallet')
                .addStringOption(o =>
                    o.setName('amount').setDescription('Amount to withdraw (or "all")').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('transfer')
                .setDescription('Transfer coins from your wallet to another user')
                .addUserOption(o =>
                    o.setName('user').setDescription('The user to transfer coins to').setRequired(true))
                .addIntegerOption(o =>
                    o.setName('amount').setDescription('Coins to send (min: 1). Must not exceed your wallet.').setRequired(true).setMinValue(1))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'deposit')  return handleDeposit(interaction);
        if (sub === 'withdraw') return handleWithdraw(interaction);
        if (sub === 'transfer') return handleTransfer(interaction);
    },
};
