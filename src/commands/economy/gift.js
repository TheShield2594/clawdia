const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { getItemLore } = require('../../data/defaultShopItems');

const DAILY_COIN_CAP = 10_000;

// Items that cannot be gifted (soulbound — matches market.js)
const SOULBOUND_ITEMS = new Set(['lifesaver', 'streak_shield']);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('gift')
        .setDescription('Send coins or an item from your inventory to another user.')
        .addUserOption(o =>
            o.setName('user')
                .setDescription('The recipient.')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('type')
                .setDescription('What to gift: coins or an item.')
                .setRequired(true)
                .addChoices(
                    { name: 'Coins', value: 'coins' },
                    { name: 'Item',  value: 'item'  }
                ))
        .addIntegerOption(o =>
            o.setName('amount')
                .setDescription('Amount of coins (if gifting coins).')
                .setMinValue(1))
        .addStringOption(o =>
            o.setName('item')
                .setDescription('Item ID to gift (if gifting an item).')
                .setAutocomplete(false))
        .addIntegerOption(o =>
            o.setName('quantity')
                .setDescription('How many of the item to gift (default 1).')
                .setMinValue(1)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const target   = interaction.options.getUser('user');
        const type     = interaction.options.getString('type');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't gift yourself.", ephemeral: true });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't gift a bot.", ephemeral: true });
        }

        if (type === 'coins') {
            const amount  = interaction.options.getInteger('amount');
            const guildId = interaction.guild.id;

            if (!amount) {
                return interaction.reply({ content: 'Specify an `amount` when gifting coins.', ephemeral: true });
            }

            // Read current state to provide user-facing balance/cap feedback before the atomic update
            const senderNow = await User.findOne({ userId: interaction.user.id, guildId });
            if (!senderNow || senderNow.balance < amount) {
                return interaction.reply({
                    content: `You only have **${currency}${(senderNow?.balance ?? 0).toLocaleString()}** in your wallet.`,
                    ephemeral: true,
                });
            }

            const capResetAge = senderNow.dailyGiftReset
                ? Date.now() - new Date(senderNow.dailyGiftReset).getTime()
                : Infinity;
            const currentSent = capResetAge >= 86_400_000 ? 0 : (senderNow.dailyGiftSent ?? 0);
            const remaining   = DAILY_COIN_CAP - currentSent;

            if (amount > remaining) {
                return interaction.reply({
                    content: `Daily gift cap reached. You can still gift up to **${currency}${remaining.toLocaleString()}** today.`,
                    ephemeral: true,
                });
            }

            // Atomic deduction: filter enforces balance and daily cap atomically so concurrent
            // gifts can't race past either check. Reset cap counter if the 24h window expired.
            const capFilter = capResetAge >= 86_400_000
                ? {}
                : { $expr: { $lte: [{ $add: ['$dailyGiftSent', amount] }, DAILY_COIN_CAP] } };

            const capUpdate = capResetAge >= 86_400_000
                ? { $inc: { balance: -amount }, $set: { dailyGiftSent: amount, dailyGiftReset: new Date() } }
                : { $inc: { balance: -amount, dailyGiftSent: amount } };

            const deducted = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId, balance: { $gte: amount }, ...capFilter },
                capUpdate,
                { new: true }
            );
            if (!deducted) {
                return interaction.reply({
                    content: 'Could not complete the transfer — your balance or daily gift cap may have changed.',
                    ephemeral: true,
                });
            }

            await User.findOneAndUpdate(
                { userId: target.id, guildId },
                { $inc: { balance: amount } },
                { upsert: true }
            );

            const newRemaining = DAILY_COIN_CAP - (deducted.dailyGiftSent ?? 0);

            const embed = new EmbedBuilder()
                .setColor('#f1c40f')
                .setTitle('🎁 Gift Sent!')
                .setDescription(`**${interaction.user.username}** gifted **${currency}${amount.toLocaleString()}** to <@${target.id}>!`)
                .addFields(
                    { name: 'Your Wallet',         value: `${currency}${deducted.balance.toLocaleString()}`, inline: true },
                    { name: 'Daily Cap Remaining', value: `${currency}${Math.max(0, newRemaining).toLocaleString()}`, inline: true },
                )
                .setTimestamp();

            const recipientEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('🎁 You Received a Gift!')
                .setDescription(`**${interaction.user.username}** sent you **${currency}${amount.toLocaleString()}**!`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await interaction.followUp({ embeds: [recipientEmbed], content: `<@${target.id}>` });

        } else {
            // Gift item
            const itemId = interaction.options.getString('item');
            const qty    = interaction.options.getInteger('quantity') ?? 1;

            if (!itemId) {
                return interaction.reply({ content: 'Specify an `item` ID when gifting an item.', ephemeral: true });
            }

            if (SOULBOUND_ITEMS.has(itemId)) {
                return interaction.reply({ content: `\`${itemId}\` is soulbound and cannot be gifted.`, ephemeral: true });
            }

            const [sender, recipient] = await Promise.all([
                User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
                User.findOneAndUpdate({ userId: target.id,           guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
            ]);

            const slot = sender.inventory.find(i => i.itemId === itemId);
            if (!slot || slot.quantity < qty) {
                return interaction.reply({
                    content: `You don't have ${qty}x \`${itemId}\` in your inventory.`,
                    ephemeral: true,
                });
            }

            // Cannot gift actively equipped effects
            const { resolveEffectType } = require('../../services/effectsService');
            const effectType = resolveEffectType(itemId);
            if (effectType && (sender.activeEffects || []).some(e => e.type === effectType)) {
                return interaction.reply({
                    content: `You can't gift \`${itemId}\` while it's active as an effect. Deactivate it first.`,
                    ephemeral: true,
                });
            }

            slot.quantity -= qty;
            if (slot.quantity <= 0) {
                sender.inventory = sender.inventory.filter(i => i.itemId !== itemId);
            }
            sender.markModified('inventory');

            const recipientSlot = recipient.inventory.find(i => i.itemId === itemId);
            if (recipientSlot) {
                recipientSlot.quantity += qty;
            } else {
                recipient.inventory.push({ itemId, quantity: qty });
            }
            recipient.markModified('inventory');

            await Promise.all([sender.save(), recipient.save()]);

            const embed = new EmbedBuilder()
                .setColor('#f1c40f')
                .setTitle('🎁 Gift Sent!')
                .setDescription(`**${interaction.user.username}** gifted **${qty}x \`${itemId}\`** to <@${target.id}>!`)
                .setTimestamp();

            const lore = getItemLore(itemId);
            const recipientDesc = lore
                ? `**${interaction.user.username}** sent you **${qty}x \`${itemId}\`**!\n\n> *${lore}*`
                : `**${interaction.user.username}** sent you **${qty}x \`${itemId}\`**!`;

            const recipientEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('🎁 You Received a Gift!')
                .setDescription(recipientDesc)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await interaction.followUp({ embeds: [recipientEmbed], content: `<@${target.id}>` });
        }
    },
};
