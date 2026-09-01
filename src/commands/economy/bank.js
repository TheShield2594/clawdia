const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { logTransaction } = require('../../utils/logTransaction');
const { giftLimits } = require('../../utils/giftCaps');
const { accountAgeRefusal, coinBudgets, commitCoinTransfer, transferRefusal } = require('../../utils/coinTransfer');
const COLORS = require('../../utils/embedColors');

async function getCurrency(guildId) {
    const guildSettings = await getGuildSettings(guildId);
    return guildSettings?.economy?.currency ?? '💰';
}

async function handleDeposit(interaction) {
    const currency = await getCurrency(interaction.guild.id);

    // Read current balance to resolve 'all' and validate, then use atomic update
    const preview = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );

    const input = interaction.options.getString('amount').toLowerCase();
    const amount = input === 'all' ? preview.balance : parseInt(input, 10);

    if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: 'Please enter a valid positive amount.', flags: MessageFlags.Ephemeral });
    }

    // Atomic transfer: only succeeds if wallet has enough
    const updated = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: amount } },
        { $inc: { balance: -amount, bank: amount } },
        { new: true }
    );

    if (!updated) {
        const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        return interaction.reply({
            content: `You only have ${currency}${(fresh?.balance ?? 0).toLocaleString()} in your wallet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    logTransaction({
        userId: interaction.user.id, guildId: interaction.guild.id, type: 'deposit',
        amount: -amount, balance: updated.balance, bank: updated.bank,
        note: `Deposited ${amount} to bank`
    });

    const isLarge = amount >= 10000;
    const depositTitle = isLarge ? '💼 Vault Secured' : '🏦 Deposit Successful';
    const depositDesc = isLarge
        ? `💼 Safely secured. **${amount.toLocaleString()} coins** locked in your vault.`
        : null;

    const depositEmbed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle(depositTitle)
        .addFields(
            { name: 'Deposited', value: `${currency}${amount.toLocaleString()}`, inline: true },
            { name: 'Wallet', value: `${currency}${updated.balance.toLocaleString()}`, inline: true },
            { name: 'Bank', value: `${currency}${updated.bank.toLocaleString()}`, inline: true }
        );

    if (depositDesc) depositEmbed.setDescription(depositDesc);

    await interaction.reply({ embeds: [depositEmbed] });
}

async function handleWithdraw(interaction) {
    const currency = await getCurrency(interaction.guild.id);

    // Read current bank balance to resolve 'all', then use atomic update
    const preview = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );

    const input = interaction.options.getString('amount').toLowerCase();
    const amount = input === 'all' ? preview.bank : parseInt(input, 10);

    if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: 'Please enter a valid positive amount.', flags: MessageFlags.Ephemeral });
    }

    // Atomic transfer: only succeeds if bank has enough
    const updated = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, bank: { $gte: amount } },
        { $inc: { bank: -amount, balance: amount } },
        { new: true }
    );

    if (!updated) {
        const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        return interaction.reply({
            content: `You only have ${currency}${(fresh?.bank ?? 0).toLocaleString()} in your bank.`,
            flags: MessageFlags.Ephemeral
        });
    }

    logTransaction({
        userId: interaction.user.id, guildId: interaction.guild.id, type: 'withdraw',
        amount, balance: updated.balance, bank: updated.bank,
        note: `Withdrew ${amount} from bank`
    });

    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('Withdrawal Successful')
        .addFields(
            { name: 'Withdrawn', value: `${currency}${Number(amount).toLocaleString()}`, inline: true },
            { name: 'Wallet', value: `${currency}${Number(updated.balance).toLocaleString()}`, inline: true },
            { name: 'Bank', value: `${currency}${Number(updated.bank).toLocaleString()}`, inline: true }
        );

    await interaction.reply({ embeds: [embed] });
}

/**
 * `/bank transfer` — the same coin movement `/gift type:coins` performs, and now
 * literally the same code (#897).
 *
 * It used to be its own implementation and a poorer one: no daily cap, no
 * account-age gate, no accounting, so the anti-alt caps `/gift` enforces were
 * decorative — anyone who hit the gift cap simply transferred instead. It also
 * debited the sender and then credited the receiver with nothing watching the
 * second write, so a credit that threw destroyed the coins outright (#868).
 *
 * Both are properties of moving coins rather than of having typed `/gift`, so
 * they live in utils/coinTransfer.js and this is the wording around them.
 */
async function handleTransfer(interaction) {
    const recipient = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const guildId = interaction.guild.id;

    if (recipient.bot) {
        return interaction.reply({ content: 'You cannot transfer coins to bots!', flags: MessageFlags.Ephemeral });
    }
    if (recipient.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot transfer coins to yourself!', flags: MessageFlags.Ephemeral });
    }

    // Deferred before any database work, and ephemerally. Everything below is
    // up to two reads and three writes against Discord's three-second
    // acknowledgement window, and a slow database turned that into "the
    // application did not respond" with the coins already moved. gift.js
    // defers first for exactly this reason; the public announcement is a
    // followUp at the end, so the transfer is still posted in the channel the
    // way it always was, and the refusals stay private the way they always
    // were.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const deny = content => interaction.editReply({ content, embeds: [], components: [] });

    const guildSettings = await getGuildSettings(guildId);
    const currency = guildSettings?.economy?.currency ?? '💰';
    const limits = giftLimits(guildSettings);

    const tooNew = accountAgeRefusal(interaction.user, recipient);
    if (tooNew) return deny(tooNew);

    // Read both sides for the refusal messages below. The atomic filters inside
    // commitCoinTransfer are what actually enforce the balance and the caps.
    const [senderNow, receiverNow] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId }),
        User.findOne({ userId: recipient.id, guildId }),
    ]);

    if (!senderNow || senderNow.balance < amount) {
        return deny(`You don't have enough coins! Your balance: ${(senderNow?.balance ?? 0).toLocaleString()} coins`);
    }

    const budgets = coinBudgets(senderNow, receiverNow, limits);
    if (amount > budgets.send.remaining) {
        return deny(`Daily transfer cap reached. You can still send up to **${currency}${budgets.send.remaining.toLocaleString()}** today.`);
    }
    if (amount > budgets.receive.remaining) {
        return deny(`<@${recipient.id}> has reached their daily receiving cap. They can receive up to **${currency}${budgets.receive.remaining.toLocaleString()}** more today.`);
    }

    const moved = await commitCoinTransfer({
        senderId: interaction.user.id, receiverId: recipient.id, guildId,
        amount, limits, budgets,
        refundKey: interaction.id, service: 'bank', jobName: 'bankTransfer',
    });

    const refusal = transferRefusal(moved, {
        mention: `<@${recipient.id}>`, currency, amount,
        sendCapLabel: 'daily transfer cap', receiveCapLabel: 'daily receiving cap',
    });
    if (refusal) return deny(refusal);

    const { sender, receiver } = moved;

    logTransaction({
        userId: interaction.user.id, guildId, type: 'transfer_send',
        amount: -amount, balance: sender.balance, relatedUserId: recipient.id
    });
    logTransaction({
        userId: recipient.id, guildId, type: 'transfer_receive',
        amount, balance: receiver.balance, relatedUserId: interaction.user.id
    });

    const capLeft = limits.coinSend
        ? Math.max(0, limits.coinSend - (sender.dailyGiftSent ?? 0))
        : Infinity;

    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('Transfer Successful')
        .setDescription(`You transferred **${amount.toLocaleString()}** coins to ${recipient}`)
        .addFields(
            { name: 'Your New Balance', value: `${currency}${sender.balance.toLocaleString()}`, inline: true },
            {
                name: 'Daily Cap Left',
                value: Number.isFinite(capLeft) ? `${currency}${capLeft.toLocaleString()}` : 'no limit',
                inline: true,
            },
        )
        .setTimestamp();

    await interaction.editReply({
        content: `✅ Sent **${currency}${amount.toLocaleString()}** to **${recipient.username}**.`,
        embeds: [], components: [],
    });
    return interaction.followUp({ embeds: [embed] });
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
