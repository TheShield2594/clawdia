'use strict';

// `/fish shop buy` — bait packs and consumables.

const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../../../models/User');
const { persistGrindIfNew } = require('../../../../utils/grindProfile');
const { BAIT_PACKS, SHOP_CONSUMABLES } = require('../../../../data/fishData');
const GrindProfile = require('../../../../models/GrindProfile');
const { attachItemThumbnail } = require('../../../../utils/itemImageHelper');
const COLORS = require('../../../../utils/embedColors');
const { creditCoinsOrOwe } = require('../../../../utils/creditOrOwe');
const { shopRefundPayoutKey, shopGrantPayoutKey } = require('../../../../utils/payoutKey');
const { grantKeyPush, resolveShopGrant } = require('../../../../utils/shopGrant');

// The coins come back through creditCoinsOrOwe, not a bare `$inc`: a refund that
// itself fails is recorded for `payouts:replay` and the player is told it is
// owed, rather than sent away with "refunded" over coins that never returned
// (#873). Keyed to the interaction so a replay cannot pay it twice.
async function refundPurchase(interaction, amount) {
    return creditCoinsOrOwe(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        amount,
        { payoutKey: shopRefundPayoutKey(interaction.id), service: 'fish', jobName: 'shopRefund' },
    );
}

// The one line every refunded purchase says, honest about whether the coins are
// actually back yet.
function refundMessage(refund, currency, amount) {
    if (refund.credited) return 'Purchase failed — your coins were refunded. Please try again.';
    if (refund.owed) return `Purchase failed, and the ${currency}${amount.toLocaleString()} charged could not be returned automatically — it has been recorded as owed and will be paid back once the problem clears. Tell an admin if it does not.`;
    return `Purchase failed, and the ${currency}${amount.toLocaleString()} charged could not be returned or recorded — please contact a server admin.`;
}

// What the player is told when the grant threw and its outcome could not be read
// back either (#1058). The coins are deliberately *not* refunded — the item may
// have been granted, and refunding a committed grant is the over-credit this
// guards against — so the line points at an admin instead of promising coins.
function unresolvedMessage(currency, amount) {
    return `Purchase failed and its outcome could not be confirmed. You have **not** been refunded automatically: if the ${currency}${amount.toLocaleString()} was charged without the item arriving, contact a server admin to sort it out.`;
}

// `override` lets the browse view drive a purchase from its buy select: it
// passes the itemId directly instead of reading it off a slash option, and the
// component interaction it hands in answers with its own ephemeral confirm.
async function handleBuy(interaction, user, currency, override = {}) {
    const itemId   = override.itemId ?? interaction.options.getString('item');
    const quantity = override.quantity ?? interaction.options.getInteger('quantity') ?? 1;
    const f        = user.fishing;

    const baitPack   = BAIT_PACKS.find(p => p.id === itemId);
    // Only what the shop prices. A crafted-only consumable (Hunter's Brew) has
    // no cost, and letting it through made the total NaN, which no balance
    // check refuses (#873).
    const consumable = baitPack ? null : SHOP_CONSUMABLES.find(c => c.id === itemId) ?? null;
    const itemDef    = baitPack ?? consumable;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item.', flags: MessageFlags.Ephemeral });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need **${currency}${totalCost.toLocaleString()}** for ${quantity}× **${itemDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    if (baitPack) {
        const totalBait = (f.bait[baitPack.baitType] ?? 0) + baitPack.quantity * quantity;
        if (totalBait > 200) {
            return interaction.reply({ content: `You can't carry more than 200 of that bait type.`, flags: MessageFlags.Ephemeral });
        }
    } else {
        const currentQty = f.consumables[itemId] ?? 0;
        if (currentQty + quantity > (consumable.maxStack ?? 99)) {
            return interaction.reply({ content: `You can only carry ${consumable.maxStack} **${consumable.name}** at a time.`, flags: MessageFlags.Ephemeral });
        }
    }

    const gainedLabel = baitPack
        ? `${baitPack.quantity * quantity} ${baitPack.baitType.replace(/_/g, ' ')}`
        : `${quantity}× ${consumable.name}`;
    const currentStock = baitPack
        ? `${f.bait[baitPack.baitType] ?? 0} in stock`
        : `${f.consumables[itemId] ?? 0}/${consumable.maxStack ?? 99} in stock`;

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${itemDef.emoji} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',         value: itemDef.name,                                 inline: true },
            { name: 'Quantity',     value: gainedLabel,                                  inline: true },
            { name: 'Total Cost',   value: `${currency}${totalCost.toLocaleString()}`,   inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',    value: currentStock,                                  inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const confirmFiles = await attachItemThumbnail(confirmEmbed, `fish:${itemId}`, interaction.guild.id, itemDef.name);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fishbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('fishbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], files: confirmFiles, flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'fishbuy_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();

            if (baitPack) {
                const baitField = `data.bait.${baitPack.baitType}`;
                const addedQty  = baitPack.quantity * quantity;

                await persistGrindIfNew(user, 'fishing');
                const updated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                    { $inc: { balance: -totalCost } },
                    { new: true }
                );
                if (!updated) {
                    return await interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
                }

                const grantKey = shopGrantPayoutKey(interaction.id);
                const identity = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing' };
                let profUpdated = null, threw = false;
                try {
                    profUpdated = await GrindProfile.findOneAndUpdate(
                        {
                            ...identity,
                            $expr: { $lte: [{ $add: [{ $ifNull: [`$${baitField}`, 0] }, addedQty] }, 200] }
                        },
                        { $inc: { [baitField]: addedQty }, $push: grantKeyPush(grantKey) },
                        { new: true }
                    );
                } catch (err) {
                    console.error('[fishshop buy] bait grant error:', err);
                    threw = true;
                }

                const state = await resolveShopGrant({ result: profUpdated, threw, identity, key: grantKey });
                if (state === 'unresolved') {
                    return await interaction.editReply({ content: unresolvedMessage(currency, totalCost), embeds: [], components: [] });
                }
                if (state === 'absent') {
                    const refund = await refundPurchase(interaction, totalCost);
                    return await interaction.editReply({ content: refundMessage(refund, currency, totalCost), embeds: [], components: [] });
                }

                f.bait[baitPack.baitType] = profUpdated?.data?.bait?.[baitPack.baitType]
                    ?? (f.bait[baitPack.baitType] ?? 0) + addedQty;
                return await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.SUCCESS)
                            .setTitle(`${baitPack.emoji} Purchased!`)
                            .setDescription(`Bought **${quantity}× ${baitPack.name}** (+${addedQty} ${baitPack.baitType.replace(/_/g, ' ')}).`)
                            .addFields(
                                { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,                           inline: true },
                                { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,                      inline: true },
                                { name: 'Stock',   value: `${f.bait[baitPack.baitType]} ${baitPack.baitType.replace(/_/g, ' ')}`, inline: true }
                            )
                            .setTimestamp()
                    ],
                    components: []
                });
            }

            // consumable path
            const consumableField = `data.consumables.${itemId}`;
            const stackCap        = consumable.maxStack ?? 99;

            await persistGrindIfNew(user, 'fishing');
            const updated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!updated) {
                return await interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
            }

            const grantKey = shopGrantPayoutKey(interaction.id);
            const identity = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing' };
            let profUpdated = null, threw = false;
            try {
                profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        ...identity,
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, stackCap] }
                    },
                    { $inc: { [consumableField]: quantity }, $push: grantKeyPush(grantKey) },
                    { new: true }
                );
            } catch (err) {
                console.error('[fishshop buy] consumable grant error:', err);
                threw = true;
            }

            const state = await resolveShopGrant({ result: profUpdated, threw, identity, key: grantKey });
            if (state === 'unresolved') {
                return await interaction.editReply({ content: unresolvedMessage(currency, totalCost), embeds: [], components: [] });
            }
            if (state === 'absent') {
                const refund = await refundPurchase(interaction, totalCost);
                return await interaction.editReply({ content: refundMessage(refund, currency, totalCost), embeds: [], components: [] });
            }

            f.consumables[itemId] = profUpdated?.data?.consumables?.[itemId]
                ?? (f.consumables[itemId] ?? 0) + quantity;

            return await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.SUCCESS)
                        .setTitle(`${consumable.emoji} Purchased!`)
                        .setDescription(`Bought **${quantity}× ${consumable.name}**.`)
                        .addFields(
                            { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,   inline: true },
                            { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`, inline: true },
                            { name: 'Stock',   value: `${f.consumables[itemId]} owned`,              inline: true }
                        )
                        .setFooter({ text: `Use /fish shop use ${consumable.id} to activate it` })
                        .setTimestamp()
                ],
                components: []
            });
        } catch (err) {
            // Every reply above is awaited so a failed one lands here rather than
            // escaping the collector as an unhandled rejection (#873). Nothing
            // here refunds or re-charges, so reaching it after a completed
            // purchase costs nothing but the message.
            console.error('[fishshop buy] purchase error:', err);
            interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

module.exports = { handleBuy };
