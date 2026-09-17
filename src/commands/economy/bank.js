const {
    SlashCommandBuilder, EmbedBuilder, MessageFlags,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
} = require('discord.js');
const User = require('../../models/User');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const { logTransaction } = require('../../utils/logTransaction');
const { giftLimits } = require('../../utils/giftCaps');
const { accountAgeRefusal, frozenRefusal, coinBudgets, commitCoinTransfer, transferRefusal } = require('../../utils/coinTransfer');
const { fetchTransactions, prettyType, signedAmount, DEFAULT_PAGE_SIZE } = require('../../utils/ledger');
const { ownedBy } = require('../../utils/collectorOwner');
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

    // The filters inside commitCoinTransfer refuse a frozen party on their own
    // (#870); this is only what turns that refusal into a sentence that names it.
    const frozen = frozenRefusal(senderNow, receiverNow, { mention: `<@${recipient.id}>` });
    if (frozen) return deny(frozen);

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

const STATEMENT_WINDOW_MS = 2 * 60_000;

/**
 * One transaction rendered as a line for the statement embed.
 *
 * The signed amount is what a receipt is for, so it leads and is fenced to stay
 * monospaced-aligned. The `type` becomes a friendly label and the `note` sits
 * under it as the detail the writer left; the counterparty — set on gifts,
 * market sales, transfers and duels — renders as a mention so the reader sees a
 * name, and `<t:…:R>` lets Discord localise the time. The running wallet balance
 * the record carries closes the line, which is what turns a list of deltas into
 * a statement.
 */
function statementLine(txn, currency) {
    const amount = `\`${signedAmount(txn.amount)}\``;
    const ts = txn.createdAt ? Math.floor(new Date(txn.createdAt).getTime() / 1000) : null;
    const when = ts ? ` · <t:${ts}:R>` : '';
    const balance = typeof txn.balance === 'number' ? ` · bal ${currency}${txn.balance.toLocaleString()}` : '';
    const head = `${amount} ${currency} · **${prettyType(txn.type)}**${when}${balance}`;

    const detailBits = [];
    if (txn.relatedUserId) detailBits.push(`with <@${txn.relatedUserId}>`);
    if (txn.note) detailBits.push(txn.note);
    const detail = detailBits.length ? `\n╰ ${detailBits.join(' · ')}` : '';
    return `${head}${detail}`;
}

/** The embed for one page of the caller's statement. */
function buildStatementEmbed({ items, page, pages, total }, { currency, user }) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setAuthor({ name: `${user.username}'s statement`, iconURL: user.displayAvatarURL({ dynamic: true }) })
        .setFooter({ text: `Page ${page} / ${pages} · ${total.toLocaleString()} transaction${total === 1 ? '' : 's'} · last 90 days` })
        .setTimestamp();

    if (!total) {
        embed.setDescription('No transactions yet. Earn or spend coins and they show up here.');
        return embed;
    }
    embed.setDescription(items.map(t => statementLine(t, currency)).join('\n'));
    return embed;
}

/** Prev/Next controls, disabled at the ends and once the window has closed. */
function statementButtons(id, { page, pages }, expired = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`stmt_prev_${id}`)
            .setLabel('◀ Newer')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(expired || page <= 1),
        new ButtonBuilder()
            .setCustomId(`stmt_next_${id}`)
            .setLabel('Older ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(expired || page >= pages),
    );
}

/**
 * `/bank statement [page]` — the caller's own transactions, newest first,
 * ephemeral and paged with buttons (#1009).
 *
 * Read-only: it never writes a `Transaction` or moves a coin. The window and the
 * owner filter mirror the other paged economy embeds; a single page (or none)
 * skips the buttons entirely.
 */
async function handleStatement(interaction) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const currency = await getCurrency(guildId);

    let page = interaction.options.getInteger('page') || 1;
    let data = await fetchTransactions({ userId, guildId, page, pageSize: DEFAULT_PAGE_SIZE });
    page = data.page;

    const single = data.pages <= 1;
    const message = await interaction.reply({
        embeds: [buildStatementEmbed(data, { currency, user: interaction.user })],
        components: single ? [] : [statementButtons(interaction.id, data)],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    });
    if (single) return;

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: ownedBy(
            userId,
            btn => btn.customId === `stmt_prev_${interaction.id}` || btn.customId === `stmt_next_${interaction.id}`,
        ),
        time: STATEMENT_WINDOW_MS,
    });

    collector.on('collect', async btn => {
        page = btn.customId.startsWith('stmt_prev_') ? page - 1 : page + 1;
        data = await fetchTransactions({ userId, guildId, page, pageSize: DEFAULT_PAGE_SIZE });
        page = data.page;
        await btn.update({
            embeds: [buildStatementEmbed(data, { currency, user: interaction.user })],
            components: [statementButtons(interaction.id, data)],
        });
    });

    collector.on('end', async () => {
        await interaction.editReply({ components: [statementButtons(interaction.id, data, true)] }).catch(() => {});
    });
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
                    o.setName('amount').setDescription('Coins to send (min: 1). Must not exceed your wallet.').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('statement')
                .setDescription('See your own transaction history — every coin movement, newest first')
                .addIntegerOption(o =>
                    o.setName('page').setDescription('Which page to open (defaults to the first)').setMinValue(1))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'deposit')   return handleDeposit(interaction);
        if (sub === 'withdraw')  return handleWithdraw(interaction);
        if (sub === 'transfer')  return handleTransfer(interaction);
        if (sub === 'statement') return handleStatement(interaction);
    },

    __test__: { statementLine, buildStatementEmbed, statementButtons },
};
