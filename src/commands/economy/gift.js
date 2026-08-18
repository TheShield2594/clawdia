const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { getItemLore } = require('../../data/defaultShopItems');
const { logTransaction } = require('../../utils/logTransaction');

const DAILY_COIN_CAP = 10_000;
// Incoming cap is higher than the outgoing cap (several friends can legitimately
// gift one person) but low enough that funneling from a farm of alts is capped.
const DAILY_RECEIVE_CAP = 25_000;
// Fresh Discord accounts can't send gifts — blocks throwaway-alt funnels.
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Items that cannot be gifted (soulbound — matches market.js)
const SOULBOUND_ITEMS = new Set(['lifesaver', 'streak_shield']);

// Add `qty` of `itemId` to a user's inventory without reading it first: bump the
// existing slot if there is one, otherwise push a new slot, guarding the push so
// two concurrent credits can never create duplicate slots for the same item.
// Returns the updated document, or null if the user document does not exist.
async function addInventoryItem(userId, guildId, itemId, qty) {
    const bumped = await User.findOneAndUpdate(
        { userId, guildId, 'inventory.itemId': itemId },
        { $inc: { 'inventory.$.quantity': qty } },
        { new: true }
    );
    if (bumped) return bumped;

    const pushed = await User.findOneAndUpdate(
        { userId, guildId, 'inventory.itemId': { $ne: itemId } },
        { $push: { inventory: { itemId, quantity: qty } } },
        { new: true }
    );
    if (pushed) return pushed;

    // A concurrent write created the slot between the two calls — bump it now.
    return User.findOneAndUpdate(
        { userId, guildId, 'inventory.itemId': itemId },
        { $inc: { 'inventory.$.quantity': qty } },
        { new: true }
    );
}

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
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const target   = interaction.options.getUser('user');
        const type     = interaction.options.getString('type');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't gift yourself.", flags: MessageFlags.Ephemeral });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't gift a bot.", flags: MessageFlags.Ephemeral });
        }
        if (Date.now() - interaction.user.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: 'Your Discord account is too new to send gifts. Try again in a few days.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (Date.now() - target.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({
                content: `${target.username}'s Discord account is too new to receive gifts.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (type === 'coins') {
            const amount  = interaction.options.getInteger('amount');
            const guildId = interaction.guild.id;

            if (!amount) {
                return interaction.reply({ content: 'Specify an `amount` when gifting coins.', flags: MessageFlags.Ephemeral });
            }

            // Read current state to provide user-facing balance/cap feedback before the atomic update
            const senderNow = await User.findOne({ userId: interaction.user.id, guildId });
            if (!senderNow || senderNow.balance < amount) {
                return interaction.reply({
                    content: `You only have **${currency}${(senderNow?.balance ?? 0).toLocaleString()}** in your wallet.`,
                    flags: MessageFlags.Ephemeral,
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
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Receiver-side daily cap — limits how much one account can be funneled per day
            const receiverNow  = await User.findOne({ userId: target.id, guildId });
            const rxResetAge   = receiverNow?.dailyGiftReceivedReset
                ? Date.now() - new Date(receiverNow.dailyGiftReceivedReset).getTime()
                : Infinity;
            const currentReceived = rxResetAge >= 86_400_000 ? 0 : (receiverNow?.dailyGiftReceived ?? 0);
            if (currentReceived + amount > DAILY_RECEIVE_CAP) {
                return interaction.reply({
                    content: `<@${target.id}> has reached their daily gift-receiving cap. They can receive up to **${currency}${Math.max(0, DAILY_RECEIVE_CAP - currentReceived).toLocaleString()}** more today.`,
                    flags: MessageFlags.Ephemeral,
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
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Ensure the receiver document exists, then credit with the receive-cap
            // enforced atomically (no upsert here — an unmatched conditional upsert
            // would try to insert a duplicate userId+guildId document).
            await User.updateOne({ userId: target.id, guildId }, {}, { upsert: true });

            const rxCapFilter = rxResetAge >= 86_400_000
                ? {}
                : { $expr: { $lte: [{ $add: [{ $ifNull: ['$dailyGiftReceived', 0] }, amount] }, DAILY_RECEIVE_CAP] } };
            const rxCapUpdate = rxResetAge >= 86_400_000
                ? { $inc: { balance: amount }, $set: { dailyGiftReceived: amount, dailyGiftReceivedReset: new Date() } }
                : { $inc: { balance: amount, dailyGiftReceived: amount } };

            const credited = await User.findOneAndUpdate(
                { userId: target.id, guildId, ...rxCapFilter },
                rxCapUpdate,
                { new: true }
            );
            if (!credited) {
                // Receiver hit their cap in a race — roll the sender back
                try {
                    await User.updateOne(
                        { userId: interaction.user.id, guildId },
                        { $inc: { balance: amount, dailyGiftSent: -amount } }
                    );
                } catch (rollbackErr) {
                    console.error(`[gift] CRITICAL: sender rollback failed — sender=${interaction.user.id} guild=${guildId} amount=${amount}:`, rollbackErr);
                    return interaction.reply({
                        content: 'Something went wrong returning your coins — please contact a server admin.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                return interaction.reply({
                    content: `Could not complete the transfer — <@${target.id}> just reached their daily gift-receiving cap. Your coins were returned.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            logTransaction({ userId: interaction.user.id, guildId, type: 'gift_send',    amount: -amount, balance: deducted.balance, relatedUserId: target.id, note: 'Coin gift' });
            logTransaction({ userId: target.id,           guildId, type: 'gift_receive', amount,          balance: credited.balance, relatedUserId: interaction.user.id, note: 'Coin gift' });

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
                return interaction.reply({ content: 'Specify an `item` ID when gifting an item.', flags: MessageFlags.Ephemeral });
            }

            if (SOULBOUND_ITEMS.has(itemId)) {
                return interaction.reply({ content: `\`${itemId}\` is soulbound and cannot be gifted.`, flags: MessageFlags.Ephemeral });
            }

            // Both documents must exist before the transfer; the sender doc is also
            // read here for the pre-flight checks below.
            const [sender] = await Promise.all([
                User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
                User.updateOne({ userId: target.id, guildId: interaction.guild.id }, {}, { upsert: true }),
            ]);

            const slot = sender.inventory.find(i => i.itemId === itemId);
            if (!slot || slot.quantity < qty) {
                return interaction.reply({
                    content: `You don't have ${qty}x \`${itemId}\` in your inventory.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Cannot gift actively equipped effects
            const { resolveEffectType } = require('../../services/effectsService');
            const effectType = resolveEffectType(itemId);
            if (effectType && (sender.activeEffects || []).some(e => e.type === effectType)) {
                return interaction.reply({
                    content: `You can't gift \`${itemId}\` while it's active as an effect. Deactivate it first.`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Debit the sender atomically first, then credit the recipient and roll
            // the debit back if the credit fails — the same shape as the coin path
            // above. Saving both documents in parallel would duplicate the item
            // whenever the sender's write lost and the recipient's won.
            const debited = await User.findOneAndUpdate(
                {
                    userId: interaction.user.id,
                    guildId: interaction.guild.id,
                    inventory: { $elemMatch: { itemId, quantity: { $gte: qty } } },
                },
                { $inc: { 'inventory.$[slot].quantity': -qty } },
                { arrayFilters: [{ 'slot.itemId': itemId }], new: true }
            );
            if (!debited) {
                return interaction.reply({
                    content: `You don't have ${qty}x \`${itemId}\` in your inventory.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            // Drop the slot once it is empty so inventory listings stay clean. A
            // failure here leaves a zero-quantity slot, which is cosmetic only.
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $pull: { inventory: { itemId, quantity: { $lte: 0 } } } }
            ).catch(() => null);

            let credited = null;
            try {
                credited = await addInventoryItem(target.id, interaction.guild.id, itemId, qty);
            } catch (creditErr) {
                console.error(`[gift] item credit failed — recipient=${target.id} guild=${interaction.guild.id} item=${itemId} qty=${qty}:`, creditErr);
            }
            if (!credited) {
                try {
                    await addInventoryItem(interaction.user.id, interaction.guild.id, itemId, qty);
                } catch (rollbackErr) {
                    console.error(`[gift] CRITICAL: item rollback failed — sender=${interaction.user.id} guild=${interaction.guild.id} item=${itemId} qty=${qty}:`, rollbackErr);
                    return interaction.reply({
                        content: 'Something went wrong returning your item — please contact a server admin.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                return interaction.reply({
                    content: 'Could not complete the transfer — your item was returned.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'gift_item_send',    amount: 0, balance: debited.balance,  relatedUserId: target.id,           note: `Gifted ${qty}x ${itemId}` });
            logTransaction({ userId: target.id,           guildId: interaction.guild.id, type: 'gift_item_receive', amount: 0, balance: credited.balance, relatedUserId: interaction.user.id, note: `Received ${qty}x ${itemId}` });

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
