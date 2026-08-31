'use strict';

// `/mine shop buy` — blast charge packs and consumables.

const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../../../models/User');
const { persistGrindIfNew } = require('../../../../utils/grindProfile');
const { BLAST_PACKS, CONSUMABLES } = require('../../../../data/mineData');
const GrindProfile = require('../../../../models/GrindProfile');
const COLORS = require('../../../../utils/embedColors');

async function handleBuy(interaction, user, currency) {
    const m = user.mining;

    const itemId  = interaction.options.getString('item');
    const qty     = interaction.options.getInteger('quantity') ?? 1;

    const consumableDef = CONSUMABLES[itemId];
    const blastDef      = BLAST_PACKS.find(b => b.id === itemId);
    const itemDef       = consumableDef || blastDef;

    if (!itemDef) return interaction.reply({ content: 'Unknown item.', flags: MessageFlags.Ephemeral });

    const totalCost = itemDef.cost * qty;
    if (user.balance < totalCost) {
        return interaction.reply({ content: `You need ${currency}${totalCost.toLocaleString()} for ${qty}× but only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
    }

    if (consumableDef) {
        const current = m.consumables[itemId] ?? 0;
        if (current + qty > consumableDef.maxStack) {
            return interaction.reply({ content: `You can only carry ${consumableDef.maxStack}× **${consumableDef.name}**. You already have ${current}.`, flags: MessageFlags.Ephemeral });
        }
    }

    const gainedLabel  = blastDef
        ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}`
        : `${qty}× ${consumableDef.name}`;
    const currentStock = blastDef
        ? `${m.charges[blastDef.chargeType] ?? 0} in stock`
        : `${m.consumables[itemId] ?? 0}/${consumableDef.maxStack} in stock`;

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${itemDef.emoji ?? '🛒'} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',         value: itemDef.name,                                  inline: true },
            { name: 'Quantity',     value: gainedLabel,                                   inline: true },
            { name: 'Total Cost',   value: `${currency}${totalCost.toLocaleString()}`,    inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',    value: currentStock,                                   inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('minebuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('minebuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const response = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true });
    const reply = response.resource.message;
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    let actionPromise = null;
    collector.on('collect', btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }

        if (btn.customId === 'minebuy_cancel') {
            collector.stop();
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        actionPromise = (async () => {
        try {
            await btn.deferUpdate();

            await persistGrindIfNew(user, 'mining');
            const balanceUpdated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!balanceUpdated) {
                return interaction.editReply({ content: 'Insufficient funds. Please try again.', embeds: [], components: [] });
            }

            if (consumableDef) {
                const consumableField = `data.consumables.${itemId}`;
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        system:  'mining',
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, qty] }, consumableDef.maxStack] }
                    },
                    { $inc: { [consumableField]: qty } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }
                m.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? qty;
            } else {
                const chargeField = `data.charges.${blastDef.chargeType}`;
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, system: 'mining' },
                    { $inc: { [chargeField]: blastDef.quantity * qty } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }
                m.charges[blastDef.chargeType] = profUpdated.data?.charges?.[blastDef.chargeType] ?? (blastDef.quantity * qty);
            }

            const received = blastDef
                ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}`
                : `${qty}× ${consumableDef.name}`;

            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.SUCCESS)
                        .setTitle('✅ Purchase Complete')
                        .setDescription(`Bought **${received}** for **${currency}${totalCost.toLocaleString()}**.`)
                        .addFields({ name: 'Balance', value: `${currency}${balanceUpdated.balance.toLocaleString()}`, inline: true })
                        .setTimestamp()
                ],
                components: []
            });
        } catch (err) {
            console.error('[mineshop buy] purchase error:', err);
            interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
        })();

        collector.stop();
    });

    return new Promise(resolve => {
        collector.on('end', async (_, reason) => {
            if (reason === 'time') {
                interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
            }
            if (actionPromise) await actionPromise.catch(() => {});
            resolve();
        });
    });
}

module.exports = { handleBuy };
