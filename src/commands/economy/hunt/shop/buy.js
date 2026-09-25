'use strict';

// `/hunt shop buy` — ammo packs and consumables.

const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const User = require('../../../../models/User');
const { persistGrindIfNew } = require('../../../../utils/grindProfile');
const { AMMO_PACKS, CONSUMABLES } = require('../../../../data/huntData');
const GrindProfile = require('../../../../models/GrindProfile');
const { ACTIVATABLE } = require('../shared');
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
        { payoutKey: shopRefundPayoutKey(interaction.id), service: 'hunt', jobName: 'shopRefund' },
    );
}

function refundMessage(refund, currency, amount) {
    if (refund.credited) return 'Purchase failed — your coins were refunded. Please try again.';
    if (refund.owed) return `Purchase failed, and the ${currency}${amount.toLocaleString()} charged could not be returned automatically — it has been recorded as owed and will be paid back once the problem clears. Tell an admin if it does not.`;
    return `Purchase failed, and the ${currency}${amount.toLocaleString()} charged could not be returned or recorded — please contact a server admin.`;
}

// Told when the grant threw and its outcome could not be read back either
// (#1058): no automatic refund, because the item may have been granted and
// refunding a committed grant is the over-credit this guards against.
function unresolvedMessage(currency, amount) {
    return `Purchase failed and its outcome could not be confirmed. You have **not** been refunded automatically: if the ${currency}${amount.toLocaleString()} was charged without the item arriving, contact a server admin to sort it out.`;
}

// `override` lets the browse view drive a purchase from its buy select: it
// passes the itemId directly instead of reading it off a slash option, and the
// component interaction it hands in answers with its own ephemeral confirm.
async function handleBuy(interaction, user, currency, override = {}) {
    const itemId   = override.itemId ?? interaction.options.getString('item');
    const quantity = override.quantity ?? interaction.options?.getInteger('quantity') ?? 1;
    const h        = user.hunt;

    const consumableDef = CONSUMABLES[itemId];
    const ammoDef       = AMMO_PACKS.find(a => a.id === itemId);
    const itemDef       = consumableDef ?? ammoDef;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item. Use `/hunt shop list` to see available items.', flags: MessageFlags.Ephemeral });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need ${currency}${totalCost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const isAmmo       = !!ammoDef;
    const currentStock = isAmmo
        ? (h.ammo[ammoDef.ammoType] ?? 0)
        : (h.consumables[itemId] ?? 0);

    if (consumableDef) {
        if (currentStock + quantity > consumableDef.maxStack) {
            return interaction.reply({
                content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    const gainedLabel = isAmmo
        ? `${ammoDef.quantity * quantity} ${ammoDef.ammoType.replace(/_/g, ' ')} rounds`
        : `${quantity}× ${consumableDef.name}`;

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${itemDef.emoji} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',        value: itemDef.name,                                inline: true },
            { name: 'Quantity',    value: gainedLabel,                                 inline: true },
            { name: 'Total Cost',  value: `${currency}${totalCost.toLocaleString()}`,  inline: true },
            { name: 'Your Balance',value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',   value: isAmmo
                ? `${currentStock} rounds in stock`
                : `${currentStock}/${consumableDef.maxStack} in stock`, inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const confirmFiles = await attachItemThumbnail(confirmEmbed, `hunt:${itemId}`, interaction.guild.id, itemDef.name);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('huntbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('huntbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], files: confirmFiles, flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'huntbuy_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();

            await persistGrindIfNew(user, 'hunt');
            const balanceUpdated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!balanceUpdated) {
                return interaction.editReply({ content: 'Insufficient funds. Please try again.', embeds: [], components: [] });
            }

            const grantKey = shopGrantPayoutKey(interaction.id);
            const identity = { userId: interaction.user.id, guildId: interaction.guild.id, system: 'hunt' };
            let newStock;
            if (consumableDef) {
                const consumableField = `data.consumables.${itemId}`;
                let profUpdated = null, threw = false;
                try {
                    profUpdated = await GrindProfile.findOneAndUpdate(
                        {
                            ...identity,
                            $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, consumableDef.maxStack] }
                        },
                        { $inc: { [consumableField]: quantity }, $push: grantKeyPush(grantKey) },
                        { new: true }
                    );
                } catch (err) {
                    console.error('[huntshop buy] consumable grant error:', err);
                    threw = true;
                }

                const state = await resolveShopGrant({ result: profUpdated, threw, identity, key: grantKey });
                if (state === 'unresolved') {
                    return interaction.editReply({ content: unresolvedMessage(currency, totalCost), embeds: [], components: [] });
                }
                if (state === 'absent') {
                    const refund = await refundPurchase(interaction, totalCost);
                    return interaction.editReply({ content: refundMessage(refund, currency, totalCost), embeds: [], components: [] });
                }
                h.consumables[itemId] = profUpdated?.data?.consumables?.[itemId] ?? (h.consumables[itemId] ?? 0) + quantity;
                newStock = `${h.consumables[itemId]}× ${consumableDef.name}`;
            } else {
                const ammoField = `data.ammo.${ammoDef.ammoType}`;
                const added = ammoDef.quantity * quantity;
                let profUpdated = null, threw = false;
                try {
                    profUpdated = await GrindProfile.findOneAndUpdate(
                        { ...identity },
                        { $inc: { [ammoField]: added }, $push: grantKeyPush(grantKey) },
                        { new: true }
                    );
                } catch (err) {
                    console.error('[huntshop buy] ammo grant error:', err);
                    threw = true;
                }

                const state = await resolveShopGrant({ result: profUpdated, threw, identity, key: grantKey });
                if (state === 'unresolved') {
                    return interaction.editReply({ content: unresolvedMessage(currency, totalCost), embeds: [], components: [] });
                }
                if (state === 'absent') {
                    const refund = await refundPurchase(interaction, totalCost);
                    return interaction.editReply({ content: refundMessage(refund, currency, totalCost), embeds: [], components: [] });
                }
                h.ammo[ammoDef.ammoType] = profUpdated?.data?.ammo?.[ammoDef.ammoType] ?? (h.ammo[ammoDef.ammoType] ?? 0) + added;
                newStock = `${h.ammo[ammoDef.ammoType]} ${ammoDef.ammoType.replace(/_/g, ' ')}`;
            }

            const finalGained = isAmmo ? `${ammoDef.quantity * quantity} rounds` : `${quantity}× ${consumableDef.name}`;
            const ammoNote    = isAmmo ? `\nAmmo stock for **${ammoDef.ammoType.replace(/_/g, ' ')}**: ${h.ammo[ammoDef.ammoType]}` : '';

            const successEmbed = new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle(`${itemDef.emoji} Purchase Successful`)
                .setDescription(`You bought **${finalGained}** for ${currency}${totalCost.toLocaleString()}.${ammoNote}`)
                .addFields(
                    { name: 'New Balance', value: `${currency}${balanceUpdated.balance.toLocaleString()}`, inline: true },
                    { name: 'In Stock',    value: newStock, inline: true }
                );

            if (!isAmmo && ACTIVATABLE.includes(itemId)) {
                successEmbed.setFooter({ text: `Activate with /hunt shop use ${itemId}` });
            }

            await interaction.editReply({ embeds: [successEmbed], components: [] });
        } catch (err) {
            console.error('[huntshop buy] purchase error:', err);
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
