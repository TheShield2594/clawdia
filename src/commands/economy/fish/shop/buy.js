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
const { BAIT_PACKS, CONSUMABLES } = require('../../../../data/fishData');
const GrindProfile = require('../../../../models/GrindProfile');
const COLORS = require('../../../../utils/embedColors');

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const f        = user.fishing;

    const baitPack   = BAIT_PACKS.find(p => p.id === itemId);
    const consumable = baitPack ? null : CONSUMABLES[itemId];
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

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fishbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('fishbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
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
                    return interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
                }

                const profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        system:  'fishing',
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${baitField}`, 0] }, addedQty] }, 200] }
                    },
                    { $inc: { [baitField]: addedQty } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }

                f.bait[baitPack.baitType] = profUpdated.data?.bait?.[baitPack.baitType] ?? addedQty;
                return interaction.editReply({
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
                return interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
            }

            const profUpdated = await GrindProfile.findOneAndUpdate(
                {
                    userId:  interaction.user.id,
                    guildId: interaction.guild.id,
                    system:  'fishing',
                    $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, stackCap] }
                },
                { $inc: { [consumableField]: quantity } },
                { new: true }
            ).catch(() => null);

            if (!profUpdated) {
                await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
            }

            f.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? quantity;

            return interaction.editReply({
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
